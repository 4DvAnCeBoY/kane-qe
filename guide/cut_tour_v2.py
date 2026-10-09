"""Cuts tour-v2-raw.mp4 into kane-qe-v2-tour.mp4: stops at the end of the tour, plays the waiting
stretches the driver marked 6x faster, and writes chapters-v2.json with the chapter times moved to match."""
import json
import subprocess

FAST = 6.0
tour = json.load(open('tour-v2.json'))
end = tour['chapters'][-1]['t'] + 4
waits = sorted([a, b] for a, b in tour['waits'] if b - a > 2 and b <= end)

# Segments of the raw video: (start, end, speed).
segs, t = [], 0.0
for a, b in waits:
    if a > t:
        segs.append((t, a, 1.0))
    segs.append((a, b, FAST))
    t = b
segs.append((t, end, 1.0))


def moved(x: float) -> float:
    out = 0.0
    for a, b, k in segs:
        if x <= a:
            break
        out += (min(x, b) - a) / k
    return round(out, 1)


parts = []
for i, (a, b, k) in enumerate(segs):
    parts.append(f'[0:v]trim=start={a}:end={b},setpts=(PTS-STARTPTS)/{k}[v{i}]')
filt = ';'.join(parts) + ';' + ''.join(f'[v{i}]' for i in range(len(segs))) + f'concat=n={len(segs)}:v=1:a=0[out]'
subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', 'tour-v2-raw.mp4', '-filter_complex', filt, '-map', '[out]',
                '-c:v', 'libx264', '-crf', '28', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'kane-qe-v2-tour.mp4'], check=True)
chapters = [{**c, 't': moved(c['t'])} for c in tour['chapters']]
json.dump(chapters, open('chapters-v2.json', 'w'), indent=2)
print('cut', len(segs), 'segments; chapters at', [c['t'] for c in chapters])
