# Bundled ConPTY (Windows)

`conpty.dll` and `OpenConsole.exe` from Microsoft's
`Microsoft.Windows.Console.ConPTY` NuGet package, version 1.25.260930003
(x64: `runtimes/win-x64/native/conpty.dll`,
`build/native/runtimes/x64/OpenConsole.exe`), unmodified.

Why: the ConPTY built into Windows does not forward a program's mouse
reporting request (`CSI ? 1000 h` and friends) to the terminal, so xterm
keeps the wheel for its own scrollback and TUIs like opencode never see it
(GH #437). portable-pty loads a `conpty.dll` found next to the exe in
preference to kernel32's, and that dll runs the `OpenConsole.exe` beside it.
Without the two files Termic falls back to the system ConPTY.

`tauri.windows.conf.json` places both next to `termic.exe`.
`src-tauri/tests/conpty_mouse.rs` proves the request comes through.

To update: download the package from nuget.org, check the version is at
least two weeks old, copy the two x64 files over these, update the version
and hashes below, and run the Windows CI job.

    nupkg       02b07b349af66d801159bdf9e440d4a1ce78bb951f37fc8609731665afdae7ee
    conpty.dll  feeef341d891643c62d30b6b07800bc70f0bc148f44cb8c3bee84aa557ae805a
    OpenConsole 3d66b23d0a71bb8eed2b77edc8b9df9bf54ce6c8fb74c863a30e760997f80586

Source: https://github.com/microsoft/terminal

MIT License

Copyright (c) Microsoft Corporation. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
