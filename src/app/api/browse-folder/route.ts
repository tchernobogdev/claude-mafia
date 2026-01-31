import { NextResponse } from "next/server";
import { execFile } from "child_process";

export async function POST() {
  return new Promise<NextResponse>((resolve) => {
    const script = `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.OpenFileDialog; $f.ValidateNames = $false; $f.CheckFileExists = $false; $f.CheckPathExists = $true; $f.FileName = 'Select Folder'; if($f.ShowDialog() -eq 'OK'){[System.IO.Path]::GetDirectoryName($f.FileName)}`;
    execFile("powershell", ["-NoProfile", "-Command", script], { timeout: 60000 }, (err, stdout) => {
      if (err) {
        resolve(NextResponse.json({ path: null }));
        return;
      }
      const selected = stdout.trim();
      resolve(NextResponse.json({ path: selected || null }));
    });
  });
}
