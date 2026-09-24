const path = require('path');
const { execFile } = require('child_process');

const projectDir = path.resolve(__dirname, '..');
const sessionProfile = path.resolve(
  projectDir,
  process.env.WHATSAPP_SESSION_PATH || './tokens/session01',
  `session-${process.env.WHATSAPP_CLIENT_ID || 'lab-wa-gateway'}`
);

if (process.platform !== 'win32') {
  console.log('[WA STOP] This helper is currently intended for Windows.');
  process.exit(0);
}

const escapedProject = projectDir.replace(/'/g, "''");
const escapedProfile = sessionProfile.replace(/'/g, "''");

const command = [
  '$project = [IO.Path]::GetFullPath(\'' + escapedProject + '\');',
  '$profile = [IO.Path]::GetFullPath(\'' + escapedProfile + '\');',
  '$nodes = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -and $_.CommandLine -like ("*" + $project + "*") -and $_.CommandLine -like "*server.js*" };',
  '$browsers = Get-CimInstance Win32_Process | Where-Object { $_.Name -in @("chrome.exe","chromium.exe","msedge.exe") -and $_.CommandLine -and $_.CommandLine -like ("*" + $profile + "*") };',
  '$all = @($nodes) + @($browsers);',
  '$all | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Output ($_.Name + ":" + $_.ProcessId) }'
].join(' ');

execFile(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
  { windowsHide: true, timeout: 10000 },
  (error, stdout, stderr) => {
    if (error) {
      console.error('[WA STOP] Failed:', error.message);
      if (stderr) console.error(stderr.trim());
      process.exit(1);
    }

    const result = String(stdout || '').trim();
    console.log(result
      ? '[WA STOP] Stopped gateway process(es):\n' + result
      : '[WA STOP] No lab_wa_gateway node/WhatsApp browser process was found.'
    );
  }
);
