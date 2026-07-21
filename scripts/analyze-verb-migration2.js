const { PROVIDERS, analyzeProviderSwitch } = require('./verb-switch-helper');

for (const p of PROVIDERS) {
    const res = analyzeProviderSwitch(p);
    if (!res) { console.log(p.name, 'switch not found'); continue; }
    console.log(`${res.name}: arms=${res.casesCount} cases, vscode=${res.vscodeCount}, execCmd=${res.execCount}, getConfig=${res.getConfigCount}, vscodeFs=${res.fsCount}, uri=${res.uriCount}, clipboard=${res.clipboardCount}, showMsg=${res.showMsgCount}, break=${res.breakCount}, return=${res.returnCount} (read-arm breaks=${res.readArmsWithBreak})`);
}
