# Records docs/demo.gif with a fake user. Run from the repo root: vhs scripts/demo/demo.tape
Output docs/demo.gif

Require bun
Require git
Require ssh-keygen
Require zsh

Set Shell zsh
Set FontSize 14
# Tall enough for the splash, which needs 40 rows
Set Width 1280
Set Height 820
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 75ms

Hide
Type "scripts/demo/setup.sh && source /tmp/qcs-demo/env.zsh && qcs --version >/dev/null && clear"
Enter
Sleep 3s
Show

Sleep 500ms
Type "qcs"
Sleep 600ms
Enter
Sleep 3.5s
Space
Sleep 3.5s

# First run: import the identities already in ~/.gitconfig, then add the suggested Scan Roots
Enter
Sleep 3s
Enter
Sleep 4s

# New Identity with its own SSH key, also used to sign commits
Type "2"
Sleep 1.5s
Type "n"
Sleep 800ms
Type "OSS"
Enter
Type "Nicolás Santuccio"
Enter
Type "nicolas@opensource.dev"
Enter
Sleep 600ms
Enter
Sleep 600ms
Right
Sleep 1.2s
Enter
Sleep 1.5s
Enter
Sleep 1.2s
Enter
Sleep 3.5s

# Assign it to the ~/oss folder
Type "1"
Sleep 1.5s
Type "a"
Sleep 1.2s
Type "j"
Sleep 400ms
Type "j"
Sleep 800ms
Enter
Sleep 3s
Type "y"
Sleep 4s
Type "q"
Sleep 800ms

# Plain git picks it up, even with qcs closed
Type "cd ~/oss/terminal-kit && qcs status"
Sleep 400ms
Enter
Sleep 3.5s
Type "git config user.email"
Sleep 400ms
Enter
Sleep 2.5s
Type "cd ~/personal/blog && qcs use oss"
Sleep 400ms
Enter
Sleep 4.5s
