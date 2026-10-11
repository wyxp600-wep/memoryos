package com.memoryos.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * MemoryOS 手机版（瘦客户端）：配对页 → WebView 装载电脑内核看板。
 * 配对 URL 形如 http://192.168.x.x:8787/?token=…（PC 侧 node dist/pair-url.mjs 打印）。
 * 服务端首次校验 ?token= 后种 cookie 并 302 到干净 URL，此后 WebView 同源请求自动带凭据。
 * 刻意不引 AndroidX：纯 android.* API，aapt2+javac+d8 手工构建（见 build-apk.sh）。
 */
public class MainActivity extends Activity {

    private static final String PREFS = "cfg";
    private static final String KEY_URL = "server_url";

    private FrameLayout root;
    private View pairing;
    private WebView web;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        // ★ 免输入通道：adb am start --es pair_url <完整地址>（绕开手机输入法把注入文本转拼音的问题）
        String intentUrl = (getIntent() == null) ? null : getIntent().getStringExtra("pair_url");
        if (intentUrl != null && (intentUrl.startsWith("http://") || intentUrl.startsWith("https://"))) {
            prefs.edit().putString(KEY_URL, intentUrl).apply();
        }
        root = new FrameLayout(this);
        // ★ 手机适配①：NoActionBar 主题下 target35 强制 edge-to-edge，系统状态栏会压住页面顶导——
        //   把状态栏高度内衬到根布局 padding，WebView 从状态栏下方开始
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override public android.view.WindowInsets onApplyWindowInsets(View v, android.view.WindowInsets insets) {
                v.setPadding(0, insets.getSystemWindowInsetTop(), 0, 0);
                return insets.consumeSystemWindowInsets();
            }
        });
        pairing = buildPairingView();
        root.addView(pairing, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        String saved = prefs.getString(KEY_URL, "");
        if (!saved.isEmpty()) enterWeb(saved);
    }

    /** 配对页：粘贴 PC 端 pair-url.mjs 打印的完整地址 → 测试连通 → 存盘进 WebView */
    private View buildPairingView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(24), dp(56), dp(24), dp(24));
        box.setBackgroundColor(Color.parseColor("#0f1115"));

        TextView title = new TextView(this);
        title.setText("MemoryOS 手机版");
        title.setTextSize(24);
        title.setTextColor(Color.WHITE);
        box.addView(title);

        TextView hint = new TextView(this);
        hint.setText("手机和电脑连同一个 WiFi。\n在电脑上运行：\nresources\\memoryos\\dist\\pair-url.mjs\n把打印的配对地址整行粘贴到下面：");
        hint.setTextSize(14);
        hint.setTextColor(Color.parseColor("#9aa0a6"));
        hint.setPadding(0, dp(16), 0, dp(16));
        box.addView(hint);

        final EditText input = new EditText(this);
        input.setHint("http://192.168.x.x:8787/?token=…");
        input.setTextSize(14);
        input.setTextColor(Color.WHITE);
        input.setHintTextColor(Color.parseColor("#5f6368"));
        input.setSingleLine(false);
        input.setMaxLines(3);
        box.addView(input);

        Button go = new Button(this);
        go.setText("测试并连接");
        go.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                String url = input.getText().toString().trim();
                if (!url.startsWith("http://") && !url.startsWith("https://")) {
                    toast("地址要以 http:// 开头（直接粘 pair-url 打印的整行）");
                    return;
                }
                testConnection(url);
            }
        });
        box.addView(go, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView foot = new TextView(this);
        foot.setText("连不上时检查：① 电脑 MemoryOS 是否在运行 ② 是否同一 WiFi\n③ 电脑防火墙是否放行 node.exe（专用网络）");
        foot.setTextSize(12);
        foot.setTextColor(Color.parseColor("#5f6368"));
        foot.setPadding(0, dp(24), 0, 0);
        box.addView(foot);
        return box;
    }

    /** 后台线程探活（4s 超时）：2xx/3xx 即视为配对成功 */
    private void testConnection(final String url) {
        toast("正在测试连接…");
        new Thread(new Runnable() {
            @Override public void run() {
                int code = -1;
                String err = null;
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    c.setConnectTimeout(4000);
                    c.setReadTimeout(4000);
                    c.setInstanceFollowRedirects(false);
                    code = c.getResponseCode();
                    InputStream is = c.getErrorStream();
                    if (is != null) is.close();
                } catch (Exception e) {
                    err = e.getMessage();
                }
                final int fCode = code;
                final String fErr = err;
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        if ((fCode >= 200 && fCode < 400)) {
                            prefs.edit().putString(KEY_URL, url).apply();
                            enterWeb(url);
                        } else if (fCode == 401) {
                            toast("电脑回了 401：token 不对，重新粘 pair-url 打印的完整地址");
                        } else if (fCode == 403) {
                            toast("电脑回了 403：内核未开局域网访问（需 MEMORY_ALLOW_LAN=1 重启内核）");
                        } else {
                            toast("连不上电脑" + (fErr != null ? "：" + fErr : "（code=" + fCode + "）"));
                        }
                    }
                });
            }
        }).start();
    }

    /** WebView 全屏 + 右下角半透明「重配」小按钮（换电脑/换网络时用） */
    private void enterWeb(final String url) {
        pairing.setVisibility(View.GONE);
        if (web == null) {
            web = new WebView(this);
            web.getSettings().setJavaScriptEnabled(true);
            web.getSettings().setDomStorageEnabled(true);
            // ★ 禁用 WebView 缓存 + 启动时清除旧缓存（修复静态文件 401 后缓存导致新代码不生效）
            web.getSettings().setCacheMode(android.webkit.WebSettings.LOAD_NO_CACHE);
            web.clearCache(true);
            // ★ 手机适配②：关掉系统「网页强制深色」（MIUI 深色模式会把浅色看板的玻璃导航染黑）
            if (android.os.Build.VERSION.SDK_INT >= 29) {
                web.getSettings().setForceDark(android.webkit.WebSettings.FORCE_DARK_OFF);
            }
            CookieManager.getInstance().setAcceptCookie(true);
            web.setWebViewClient(new WebViewClient());
            root.addView(web, 0, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            // 重配按钮已按用户要求移除（换配对地址请卸载重装或清除 App 数据）
        }
        web.loadUrl(url);
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_LONG).show();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}
