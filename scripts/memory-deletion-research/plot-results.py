#!/usr/bin/env python3
"""Create descriptive research figures from the committed per-case observations."""
import argparse
import json
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--report', required=True, type=Path)
parser.add_argument('--out', required=True, type=Path)
args = parser.parse_args()
report = json.loads(args.report.read_text())
args.out.mkdir(parents=True, exist_ok=True)
plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 9, 'pdf.fonttype': 42, 'axes.spines.top': False, 'axes.spines.right': False})
arms = report['protocol']['arms']
labels = {'soft-delete': 'Soft delete', 'cleanup-only': 'Cleanup only',
          'verified-cleanup': 'Verified cleanup', 'guarded-cleanup': 'Guarded cleanup',
          'verified-guarded': 'Verified + guarded'}
names = [labels[arm] for arm in arms]
denominator = report['protocol']['casesPerArm']

fig, ax = plt.subplots(figsize=(7.1, 2.9), constrained_layout=True)
left = np.zeros(len(arms))
groups = [
    ('Safe completion', '#26645e', lambda r: r.get('safeCompletion', False)),
    ('Incorrect completion', '#b84a46', lambda r: r.get('falseCompletion', False)),
    ('Later resurrection', '#d88a4b', lambda r: r.get('resurrection', False)),
    ('Blocked, residue remains', '#c4ac53', lambda r: not r['completed'] and not r.get('error')),
]
for label, color, predicate in groups:
    values = [sum(predicate(r) for r in report['cases'] if r['arm'] == arm) for arm in arms]
    ax.barh(names, values, left=left, color=color, height=.62, label=label)
    for i, n in enumerate(values):
        if n: ax.text(left[i] + n / 2, i, str(n), ha='center', va='center', color='white' if label != 'Blocked, residue remains' else '#222222', weight='bold')
    left += values
ax.invert_yaxis()
ax.set(xlim=(0, denominator), xlabel=f'Cases (fixed denominator: {denominator} per arm)',
       xticks=sorted(set([0, *range(5, denominator, 5), denominator])))
ax.legend(loc='upper center', bbox_to_anchor=(.48, -.25), ncol=2, frameon=False, fontsize=8)
fig.savefig(args.out / 'outcomes.png', dpi=220, bbox_inches='tight')
fig.savefig(args.out / 'outcomes.pdf', bbox_inches='tight')
plt.close(fig)

data = [[r['totalMs'] for r in report['latency'] if r['arm'] == arm and r['error'] is None] for arm in arms]
fig, ax = plt.subplots(figsize=(7.1, 2.65), constrained_layout=True)
box = ax.boxplot(data, tick_labels=names, patch_artist=True, widths=.46, showfliers=True,
                 medianprops={'color': '#111111', 'linewidth': 1.2})
for patch in box['boxes']: patch.set(facecolor='#bfd8d2', edgecolor='#26645e')
ax.set(yscale='log', ylabel='Cleanup + verification (ms, log scale)')
ax.tick_params(axis='x', labelsize=8)
ax.grid(axis='y', alpha=.18)
fig.savefig(args.out / 'latency.png', dpi=220, bbox_inches='tight')
fig.savefig(args.out / 'latency.pdf', bbox_inches='tight')
plt.close(fig)
print(args.out)
