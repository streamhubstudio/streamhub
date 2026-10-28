# Presence of this file at the package root makes pytest add this directory to
# sys.path (prepend import mode), so `import vision_edge` resolves without an
# install. No fixtures needed — the pure-logic tests inject their own fakes
# (no torch/opencv/insightface/websockets/network).
