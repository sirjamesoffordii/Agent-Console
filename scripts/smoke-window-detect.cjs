'use strict';
const cp = require('child_process');
const ps =
  "Get-CimInstance Win32_Process | " +
  "Where-Object { $_.Name -eq 'Code - Insiders.exe' } | " +
  "ForEach-Object { $_.CommandLine } | Where-Object { $_ } | " +
  "ForEach-Object { $_ + [char]0 }";
const out = cp.execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
const lines = out.split('\u0000').map((l) => l.trim()).filter(Boolean);
console.log('processes:', lines.length);
for (const l of lines) {
  const m = l.match(/--user-data-dir[= ]"?([^" ]+)/);
  console.log(' udd:', m ? m[1] : '(host)');
}
