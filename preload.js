const { contextBridge, ipcRenderer, webUtils } = require('electron');
const inv = c => (...a) => ipcRenderer.invoke(c, ...a);
contextBridge.exposeInMainWorld('api', {
  versions: inv('versions'), launch: inv('launch'), java: inv('java:list'), javaAdd: inv('java:add'), icons: inv('icons'),
  instList: inv('inst:list'), instAdd: inv('inst:add'), instRm: inv('inst:rm'), instToggle: inv('inst:toggle'), instOpen: inv('inst:open'), instDelete: inv('inst:delete'),
  authState: inv('auth:state'), authLogin: inv('auth:login'), authCancel: inv('auth:cancel'), authLogout: inv('auth:logout'),
  skinPick: inv('skin:pick'), skinApply: inv('skin:apply'), stop: inv('game:stop'), loaderVersions: inv('loader:versions'),
  mrSearch: inv('mr:search'), mrInstall: inv('mr:install'), capeSet: inv('cape:set'), skinHist: inv('skin:hist'), skinUse: inv('skin:use'), skinHistDel: inv('skin:histdel'),
  shortcutCreate: inv('shortcut:create'), launchPending: inv('launch:pending'),
  appVersion: inv('app:version'), updCheck: inv('upd:check'), updDownload: inv('upd:download'), updInstall: inv('upd:install'),
  presence: inv('rpc:set'), rpcInfo: inv('rpc:info'),
  imgFetch: inv('img:fetch'), authList: inv('auth:list'), authSelect: inv('auth:select'), elyLogin: inv('ely:login'), mrpackExport: inv('mrpack:export'), mrModpack: inv('mr:modpack'),
  mrPlan: inv('mr:plan'), iconPick: inv('icon:pick'), mrIdentify: inv('mr:identify'), mrCategories: inv('mr:categories'), mrProject: inv('mr:project'), openUrl: inv('open:url'), shotCopy: inv('shot:copy'), mrApply: inv('mr:apply'),
  profileExport: inv('profile:export'), profileImport: inv('profile:import'), profileCopy: inv('profile:copy'), instCopy: inv('inst:copy'),
  pathOf: f => webUtils.getPathForFile(f),
  srvList: inv('srv:list'), srvAdd: inv('srv:add'), srvRm: inv('srv:rm'),
  getConfig: inv('cfg:get'), setConfig: inv('cfg:set'), locale: inv('locale'),
  on: (ch, f) => ipcRenderer.on(ch, (_, ...a) => f(...a))
});
