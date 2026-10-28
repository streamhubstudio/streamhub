# Presence of this file at the package root makes pytest add this directory to
# sys.path (prepend import mode), so `import people_counter_worker` resolves
# without an install. No fixtures needed — the pure-logic tests inject their
# own fakes (no torch/opencv/network).
