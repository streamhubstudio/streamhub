"""Segment-crossing math — incl. the direction sign against the rotated/flipped
IN arrow (the dashboard editor and the worker must agree on what 'in' means)."""
import math

from people_counter_worker.geometry import (
    crossing_direction,
    point_segment_distance,
    segments_intersect,
    side_of_line,
)

# A horizontal line, directed left→right, across the middle of the frame.
H_A, H_B = (0.2, 0.5), (0.8, 0.5)
# A vertical line, directed top→bottom.
V_A, V_B = (0.5, 0.2), (0.5, 0.8)


class TestSideOfLine:
    def test_below_horizontal_line_is_right_side(self):
        # Screen coords, y DOWN: walking a→b (rightward), right hand points down.
        assert side_of_line((0.5, 0.9), H_A, H_B) == 1

    def test_above_horizontal_line_is_left_side(self):
        assert side_of_line((0.5, 0.1), H_A, H_B) == -1

    def test_on_the_line_is_zero(self):
        assert side_of_line((0.5, 0.5), H_A, H_B) == 0

    def test_vertical_line_sides(self):
        # Directed downward: right side of a→b is screen-LEFT (x < 0.5).
        assert side_of_line((0.1, 0.5), V_A, V_B) == 1
        assert side_of_line((0.9, 0.5), V_A, V_B) == -1

    def test_reversing_the_line_flips_the_sign(self):
        p = (0.5, 0.9)
        assert side_of_line(p, H_A, H_B) == -side_of_line(p, H_B, H_A)


class TestSegmentsIntersect:
    def test_clean_crossing(self):
        assert segments_intersect((0.5, 0.3), (0.5, 0.7), H_A, H_B)

    def test_no_crossing_when_parallel(self):
        assert not segments_intersect((0.2, 0.6), (0.8, 0.6), H_A, H_B)

    def test_no_crossing_outside_the_segment_span(self):
        # Crosses the infinite line but beyond the segment's endpoints.
        assert not segments_intersect((0.9, 0.3), (0.9, 0.7), H_A, H_B)

    def test_zero_length_movement_is_no_crossing(self):
        assert not segments_intersect((0.5, 0.5), (0.5, 0.5), H_A, H_B)

    def test_buffer_catches_a_step_ending_on_the_line(self):
        # Movement stops just short of the line; the Vision One buffer
        # extension still registers the touch.
        assert segments_intersect((0.5, 0.4), (0.5, 0.4999), H_A, H_B, buffer=0.01)
        assert not segments_intersect((0.5, 0.4), (0.5, 0.4999), H_A, H_B, buffer=0.0)


class TestCrossingDirection:
    def test_downward_is_in_when_inside_is_right(self):
        # a→b points right, so 'right' (inside) is BELOW the line: moving down = in.
        assert crossing_direction((0.5, 0.4), (0.5, 0.6), H_A, H_B, "right") == "in"

    def test_upward_is_out_when_inside_is_right(self):
        assert crossing_direction((0.5, 0.6), (0.5, 0.4), H_A, H_B, "right") == "out"

    def test_flipping_the_arrow_swaps_in_and_out(self):
        # The editor's flip button swaps in_side — same movement, opposite count.
        assert crossing_direction((0.5, 0.4), (0.5, 0.6), H_A, H_B, "left") == "out"
        assert crossing_direction((0.5, 0.6), (0.5, 0.4), H_A, H_B, "left") == "in"

    def test_reversed_line_with_flipped_side_is_equivalent(self):
        # Drawing the line b→a AND flipping the side = the original setup.
        down = ((0.5, 0.4), (0.5, 0.6))
        assert crossing_direction(*down, H_A, H_B, "right") == crossing_direction(
            *down, H_B, H_A, "left"
        )

    def test_rotated_line_diagonal(self):
        # 45° line ↘ from (0.2,0.2) to (0.8,0.8); a move from upper-right to
        # lower-left crosses onto the RIGHT side of a→b.
        a, b = (0.2, 0.2), (0.8, 0.8)
        prev, cur = (0.7, 0.3), (0.3, 0.7)
        assert side_of_line(cur, a, b) == 1
        assert crossing_direction(prev, cur, a, b, "right") == "in"
        assert crossing_direction(prev, cur, a, b, "left") == "out"

    def test_vertical_line_left_to_right_movement(self):
        # Crossing the vertical (downward-directed) line rightward lands on
        # the LEFT side of a→b.
        assert crossing_direction((0.4, 0.5), (0.6, 0.5), V_A, V_B, "left") == "in"
        assert crossing_direction((0.4, 0.5), (0.6, 0.5), V_A, V_B, "right") == "out"

    def test_no_direction_without_intersection(self):
        assert crossing_direction((0.5, 0.6), (0.5, 0.9), H_A, H_B, "right") is None

    def test_no_direction_sliding_along_the_line(self):
        # Intersects geometrically (collinear overlap is parallel → False
        # anyway) but never changes side.
        assert crossing_direction((0.3, 0.5), (0.7, 0.5), H_A, H_B, "right") is None


class TestPointSegmentDistance:
    def test_perpendicular_distance(self):
        assert math.isclose(point_segment_distance((0.5, 0.8), H_A, H_B), 0.3)

    def test_clamps_to_segment_end(self):
        # Beyond b: distance to the ENDPOINT, not the infinite line.
        d = point_segment_distance((1.0, 0.5), H_A, H_B)
        assert math.isclose(d, 0.2)

    def test_degenerate_segment(self):
        assert math.isclose(
            point_segment_distance((0.5, 0.9), (0.5, 0.5), (0.5, 0.5)), 0.4
        )
