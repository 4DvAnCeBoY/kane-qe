#!/bin/zsh
set -u
cd "$(dirname "$0")"
# A kane project to record in: saved tests, a requirement store (.context) and evidence make every tab show something.
DEMO_DIR="${KANE_DEMO_DIR:?set KANE_DEMO_DIR to a kane project folder}"
export KANE_DEMO_DIR
tmux -L kqvid kill-server 2>/dev/null
tmux -L kqvid -f /dev/null new-session -d -s kq -x 176 -y 52 -c "$DEMO_DIR" 'CLAUDE_CODE_NO_FLICKER=1 claude'
tmux -L kqvid set -g status off
tmux -L kqvid set -as terminal-features ',xterm*:RGB'; tmux -L kqvid set -g window-size latest
sleep 14
tmux -L kqvid send-keys -t kq '/clear' Enter; sleep 4
vhs tour.tape > vhs.log 2>&1 &
VHS=$!
until tmux -L kqvid list-clients | grep -q .; do sleep 0.2; done
sleep 1.1
python3 tour_driver.py chapters.json 2> driver.log
echo "driver exit $?" >> driver.log
wait $VHS
echo "vhs exit $?" >> driver.log
