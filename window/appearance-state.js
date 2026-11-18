"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");
const themes = require("./appearance-themes.json");
const stateFile = () => path.join(app.getPath("userData"), "appearance-startup.json");
const DEFAULT_SKIN = "sky";
function normalize(value) {
  const skin = typeof value?.skin === "string" && Object.hasOwn(themes, value.skin) ? value.skin : DEFAULT_SKIN;
  return { skin, theme: themes[skin].scheme, reduceMotion: value?.reduceMotion === true };
}
function read() { try { return normalize(JSON.parse(fs.readFileSync(stateFile(), "utf8"))); } catch { return normalize({}); } }
function theme(value = read()) {
  const state = normalize(value);
  return { ...themes[state.skin], ...state };
}
function save(value) {
  const next=normalize(value), json=JSON.stringify(next);
  if(fs.existsSync(stateFile()) && fs.readFileSync(stateFile(), "utf8") === json) return next;
  fs.mkdirSync(path.dirname(stateFile()), {recursive:true});
  fs.writeFileSync(stateFile()+".tmp", json, "utf8");
  fs.renameSync(stateFile()+".tmp", stateFile());
  return next;
}
module.exports={read,theme,save,hasSaved:()=>fs.existsSync(stateFile())};
