#!/bin/zsh
# Records the v2 walkthrough: a real Claude Code session in a kane project, every kane-cli run real.
# Needs vhs, tmux, ffmpeg, a kane-cli login, and KANE_DEMO_DIR: a git project with saved tests
# (.testmuai/tests: cart_add, search_ipod, login_page), a requirement store (.context) and src/cart/addToCart.ts.
set -u
cd "$(dirname "$0")"
DEMO_DIR="${KANE_DEMO_DIR:?set KANE_DEMO_DIR to the demo project}"
export KANE_DEMO_DIR
tmux -L kqvid kill-server 2>/dev/null
tmux -L kqvid -f /dev/null new-session -d -s kq -x 176 -y 52 -c "$DEMO_DIR" "CLAUDE_CODE_NO_FLICKER=1 claude --allowedTools 'Bash(kane-cli:*)' Edit Read"
tmux -L kqvid set -g status off
tmux -L kqvid set -as terminal-features ',xterm*:RGB'; tmux -L kqvid set -g window-size latest
sleep 10
# A folder Claude Code has not seen asks whether to trust it: the demo project is ours.
if tmux -L kqvid capture-pane -t kq -p | grep -q 'trust this folder'; then tmux -L kqvid send-keys -t kq Down; sleep 0.3; tmux -L kqvid send-keys -t kq Enter; sleep 6; fi
until tmux -L kqvid capture-pane -t kq -p | grep -q ' idle '; do sleep 1; done
vhs tour_v2.tape > vhs-v2.log 2>&1 &
VHS=$!
until tmux -L kqvid list-clients | grep -q .; do sleep 0.2; done
sleep 1.1
python3 tour_driver_v2.py tour-v2.json 2> driver-v2.log
echo "driver exit $?" >> driver-v2.log
wait $VHS
echo "vhs exit $?" >> driver-v2.log
python3 cut_tour_v2.py
