#!/usr/bin/env bash
# MemoryOS 手机版 APK 手工构建（无 Gradle/AndroidX）：aapt2 → javac → d8 → 打包 → zipalign → apksigner
# 工具链（脚本 _get-toolchain.sh 下载）：JDK17 + platform-35 + build-tools 35.0.0
set -euo pipefail
SDK="/c/Users/WYX/AppData/Local/Android/Sdk"
BT="$SDK/build-tools/35.0.0"
PLAT="$SDK/platforms/android-35/android.jar"
JDK="/c/tools/jdk/jdk-17/bin"
export PATH="$JDK:$PATH"
export JAVA_HOME="C:\\tools\\jdk\\jdk-17"

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
rm -rf build && mkdir -p build/classes build/dex gen

echo "[1/7] aapt2 compile"
"$BT/aapt2.exe" compile --dir res -o build/res.zip

echo "[2/7] aapt2 link"
"$BT/aapt2.exe" link -I "$PLAT" --manifest AndroidManifest.xml --java gen \
  -o build/base.apk --min-sdk-version 26 --target-sdk-version 35 build/res.zip

echo "[3/7] javac"
"$JDK/javac.exe" -encoding UTF-8 --release 8 -classpath "$PLAT" -d build/classes \
  gen/com/memoryos/mobile/R.java src/com/memoryos/mobile/MainActivity.java

echo "[4/7] d8 dex"
find build/classes -name '*.class' > build/classlist.txt
"$BT/d8.bat" --lib "$PLAT" --release --output build/dex @build/classlist.txt

echo "[5/7] 打包 classes.dex 进 APK"
cp build/base.apk build/app.apk
(cd build/dex && jar uf ../app.apk classes.dex)

echo "[6/7] zipalign"
"$BT/zipalign.exe" -f 4 build/app.apk build/app-aligned.apk

echo "[7/7] 签名"
KS="$HERE/release.keystore"   # ★ 签名密钥放 build/ 外（build 每次清空；换密钥=换签名=无法覆盖安装）
if [ ! -f "$KS" ]; then
  "$JDK/keytool.exe" -genkeypair -keystore "$KS" -alias memoryos -keyalg RSA -keysize 2048 \
    -validity 10000 -storepass memoryos-mobile -keypass memoryos-mobile \
    -dname "CN=MemoryOS Mobile, O=MemoryOS"
fi
"$BT/apksigner.bat" sign --ks "$KS" --ks-pass pass:memoryos-mobile --key-pass pass:memoryos-mobile \
  --out build/MemoryOSMobile.apk build/app-aligned.apk

echo "== 验签 =="
"$BT/apksigner.bat" verify --print-certs build/MemoryOSMobile.apk | head -5
echo "== badging =="
"$BT/aapt.exe" dump badging build/MemoryOSMobile.apk | grep -E "^package|^application-label|launchable" | head -5
ls -la build/MemoryOSMobile.apk
echo "APK_BUILD_DONE: $HERE/build/MemoryOSMobile.apk"
