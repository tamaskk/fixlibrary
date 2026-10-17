"""The thresholds of the structure rules (T-029), in one place to tune them.

Every share is of the track's own level, so a quiet master and a loud one are read
alike. The rules are made for house; other genres may need other values.
"""

# A Start: the first bar whose whole energy rises above this share of the loudest bar.
START_SHARE = 0.01

# B Bassline: the first bar from which this many bars in a row have a bass above this
# share of the bass's 90th percentile.
BASS_SHARE = 0.25
BASS_BARS = 2

# C Vocal: the first bar whose vocals rise above this share of their 90th percentile.
VOCAL_SHARE = 0.20
# A track whose vocals' 90th percentile is below this share of the whole energy's 90th
# percentile is instrumental: no vocal cue.
INSTRUMENTAL_SHARE = 0.03

# D, F, H Drops: a phrase whose pulse (drums + bass) reaches this share of the loudest
# phrase's pulse, after a phrase at most this share of it.
DROP_SHARE = 0.80
BEFORE_DROP_SHARE = 0.60
MAX_DROPS = 3

# E Breakdown: the first phrase after Drop 1 whose pulse falls below this share of
# Drop 1's.
BREAKDOWN_SHARE = 0.50

# G Outro: the earliest phrase after the last drop from which vocals and other stay
# below this share of their own 90th percentile to the end; else this many bars
# before the last beat.
OUTRO_SHARE = 0.30
OUTRO_FALLBACK_BARS = 32

# Phrases are this many bars from the first bar; B and C go to a phrase start this
# many bars away at most, else they stay on their bar.
PHRASE_BARS = 8
SNAP_BARS = 2
