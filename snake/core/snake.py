"""
The player snake: a continuous, mouse-steered "rope" body.

Unlike a classic grid snake, this one is a free-floating agent.  The head is a
point that travels at `speed` pixels per second along `heading`, and the body
is *derived* from where the head has been: every head position is pushed onto
`path` (newest first) and the visible `segments` are resampled from that path
at fixed arc-length intervals.  That decoupling is what makes the movement read
as a slither instead of a chain of hops:

    path      raw, unevenly spaced history of head positions (newest first)
    segments  evenly spaced points along that history, one every
              C.SNAKE_SEGMENT_SPACING pixels, linearly interpolated between
              path samples so the body is smooth rather than stepped

Steering is rate limited: each (sub)step the heading rotates toward the stored
mouse target by at most `turn_rate * dt` radians, so the snake sweeps an arc
and can never snap around instantly.

This module is pure simulation - it contains no drawing code whatsoever and
imports nothing from `gfx`.
"""

from __future__ import annotations

import math
from typing import List, Optional

from .. import config as C
from .contracts import Vec2, angle_to, approach_angle, clamp, dist_sq, lerp

# --------------------------------------------------------------------------
# Module tuning that is genuinely internal (shape of the simulation, not game
# balance).  Anything a designer would want to touch lives in config.py.
# --------------------------------------------------------------------------

#: Never let the body shrink below this many segments, whatever hits land.
MIN_LENGTH: int = 4

#: Absolute ceiling on body length, so a pathological score cannot make the
#: per-frame resample loop unbounded.
MAX_LENGTH: int = 400

#: Head movement is integrated in sub-steps no longer than this many pixels.
#: At ~850 px/s (max speed x boost) and a 50 ms stall a single step would jump
#: 42 px - far enough to cut corners and to leave the path too coarse to
#: interpolate nicely.  Sub-stepping keeps the recorded path dense and makes
#: turning arcs accurate at any frame rate.
_MAX_SUBSTEP_PX: float = 7.0
_MAX_SUBSTEPS: int = 8

#: A new path sample is only recorded once the head has moved at least this
#: far; below it the newest sample is slid onto the head instead.  Keeps the
#: path from filling with duplicate points while standing still.
_PATH_MIN_STEP: float = 1.6

#: Hard cap on stored path samples (belt and braces against runaway memory).
_MAX_PATH_POINTS: int = 3000

#: Fraction of the body length over which the head radius blends into the
#: body radius; the remainder tapers body -> tail.
_NECK_FRACTION: float = 0.16

#: Exponent of the body -> tail taper.  > 1 keeps the body fat for most of its
#: length and then thins quickly near the tip, which reads as "snake" rather
#: than "cone".
_TAPER_EXP: float = 1.55

#: Collision forgiveness: the head and body circles are tested slightly
#: smaller than they are drawn so grazes do not feel unfair.
_HEAD_HIT_SCALE: float = 0.72
_BODY_HIT_SCALE: float = 0.78


class Snake:
    """
    The player entity.

    Public attributes (other modules read these directly):

        x, y            head position in arena pixels
        heading         head direction, radians (0 = +x, growing clockwise on
                        screen because y points down)
        speed           cruising speed in px/s before boost / multipliers
        alive           False once :meth:`kill` has been called
        boost           boost stamina, 0 .. C.SNAKE_BOOST_MAX
        boosting        True on the frames the boost is actually engaged
        invuln          seconds of mercy invulnerability still remaining
        path            head history, newest FIRST
        segments        resampled body points, index 0 nearest the head
        target_length   how many segments the body is growing toward
        current_speed   effective px/s used on the last update (renderers and
                        particle emitters use this for stretch / trail rate)
        bank            smoothed turn signal in -1..1, handy for leaning the
                        head sprite into a turn
    """

    # (Deliberately no __slots__: scenes and effects layers routinely tag extra
    # state onto the player entity, and silently forbidding that would be a
    # nasty integration surprise.)

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------
    def __init__(
        self,
        x: float,
        y: float,
        heading: float = 0.0,
        length: int = C.SNAKE_START_LENGTH,
    ) -> None:
        self.x: float = float(x)
        self.y: float = float(y)
        self.heading: float = float(heading)
        self.speed: float = float(C.SNAKE_BASE_SPEED)
        self.alive: bool = True

        self.boost: float = float(C.SNAKE_BOOST_MAX)
        self.boosting: bool = False
        self.invuln: float = 0.0

        self.target_length: int = int(clamp(float(length), MIN_LENGTH, MAX_LENGTH))
        self.current_speed: float = self.speed
        self.bank: float = 0.0
        self.distance_travelled: float = 0.0

        self._target: Optional[Vec2] = None
        # Spacing is read once and floored, so a bad config value can never
        # turn the resample loop into an infinite one.
        self._spacing: float = max(1.0, float(C.SNAKE_SEGMENT_SPACING))
        # Keep a little more history than the body strictly needs; the extra
        # tail slack means growth is instantly visible.
        self._path_margin: float = self._spacing * 2.0 + 8.0

        self.path: List[Vec2] = []
        self.segments: List[Vec2] = []
        self._seed_path()
        self._resolve_segments()

    def _seed_path(self) -> None:
        """Lay a straight tail behind the head so the body exists at spawn."""
        self.path.clear()
        step = min(6.0, self._spacing * 0.5)
        needed = self.target_length * self._spacing + self._path_margin
        count = int(needed / step) + 2
        cos_h, sin_h = math.cos(self.heading), math.sin(self.heading)
        for i in range(count):
            back = step * i
            self.path.append((self.x - cos_h * back, self.y - sin_h * back))

    # ------------------------------------------------------------------
    # Queries
    # ------------------------------------------------------------------
    def head_pos(self) -> Vec2:
        return (self.x, self.y)

    def tail_pos(self) -> Vec2:
        """Position of the tail tip (falls back to the head if bodyless)."""
        if self.segments:
            return self.segments[-1]
        return (self.x, self.y)

    def heading_vector(self) -> Vec2:
        return (math.cos(self.heading), math.sin(self.heading))

    def nose_pos(self, offset: Optional[float] = None) -> Vec2:
        """Point `offset` px ahead of the head centre (default: head radius)."""
        d = C.SNAKE_HEAD_RADIUS if offset is None else offset
        return (self.x + math.cos(self.heading) * d,
                self.y + math.sin(self.heading) * d)

    @property
    def boost_frac(self) -> float:
        """Boost stamina as 0..1, for HUD bars."""
        if C.SNAKE_BOOST_MAX <= 0.0:
            return 0.0
        return clamp(self.boost / float(C.SNAKE_BOOST_MAX), 0.0, 1.0)

    @property
    def length(self) -> int:
        """Number of body segments currently resolved."""
        return len(self.segments)

    def radius_at(self, i: int) -> float:
        """
        Drawn radius of body segment `i` (index 0 is nearest the head).

        The profile is head -> body over the first `_NECK_FRACTION` of the
        body, then an eased body -> tail taper over the remainder.  Passing a
        negative index asks for the head itself.
        """
        if i < 0:
            return float(C.SNAKE_HEAD_RADIUS)
        n = len(self.segments)
        if n <= 1:
            return float(C.SNAKE_BODY_RADIUS)
        t = clamp(i / float(n - 1), 0.0, 1.0)
        if t < _NECK_FRACTION:
            return lerp(C.SNAKE_HEAD_RADIUS, C.SNAKE_BODY_RADIUS, t / _NECK_FRACTION)
        u = (t - _NECK_FRACTION) / (1.0 - _NECK_FRACTION)
        return lerp(C.SNAKE_BODY_RADIUS, C.SNAKE_TAIL_RADIUS, u ** _TAPER_EXP)

    def hits_self(self) -> bool:
        """True when the head circle overlaps its own body past the skip zone."""
        try:
            if not self.alive:
                return False
            segs = self.segments
            start = int(C.SELF_COLLISION_SKIP)
            if start < 1:
                start = 1
            if len(segs) <= start:
                return False
            hx, hy = self.x, self.y
            head_r = C.SNAKE_HEAD_RADIUS * _HEAD_HIT_SCALE
            for i in range(start, len(segs)):
                sx, sy = segs[i]
                rr = head_r + self.radius_at(i) * _BODY_HIT_SCALE
                if dist_sq(hx, hy, sx, sy) <= rr * rr:
                    return True
            return False
        except Exception:  # pragma: no cover - collision must never crash a frame
            return False

    # ------------------------------------------------------------------
    # Commands
    # ------------------------------------------------------------------
    def set_target(self, tx: float, ty: float) -> None:
        """Store the point (normally the mouse) the head should steer toward."""
        try:
            self._target = (float(tx), float(ty))
        except (TypeError, ValueError):
            self._target = None

    def clear_target(self) -> None:
        """Forget the steering target; the snake then holds its heading."""
        self._target = None

    def grow(self, n: int = 1) -> None:
        self.target_length = int(clamp(self.target_length + int(n),
                                       MIN_LENGTH, MAX_LENGTH))

    def shrink(self, n: int = 1) -> None:
        self.target_length = int(clamp(self.target_length - int(n),
                                       MIN_LENGTH, MAX_LENGTH))

    def kill(self) -> None:
        self.alive = False
        self.boosting = False

    def teleport(self, nx: float, ny: float) -> None:
        """
        Move the whole snake so the head lands on (nx, ny).

        The entire path is translated by the same delta, so the body keeps its
        shape and the rope never develops a bogus stretched link.  Used for
        portals and for wrap-around walls.
        """
        try:
            dx, dy = float(nx) - self.x, float(ny) - self.y
            if dx == 0.0 and dy == 0.0:
                return
            self.x += dx
            self.y += dy
            self.path[:] = [(px + dx, py + dy) for px, py in self.path]
            self.segments[:] = [(sx + dx, sy + dy) for sx, sy in self.segments]
        except Exception:  # pragma: no cover
            pass

    def reset(self, x: float, y: float, heading: Optional[float] = None,
              length: Optional[int] = None) -> None:
        """Respawn in place: reset pose, path and stamina but keep nothing stale."""
        self.x, self.y = float(x), float(y)
        if heading is not None:
            self.heading = float(heading)
        if length is not None:
            self.target_length = int(clamp(float(length), MIN_LENGTH, MAX_LENGTH))
        self.alive = True
        self.boosting = False
        self.bank = 0.0
        self.current_speed = self.speed
        self._target = None
        self._seed_path()
        self._resolve_segments()

    # ------------------------------------------------------------------
    # Simulation
    # ------------------------------------------------------------------
    def update(
        self,
        dt: float,
        *,
        boost: bool = False,
        speed_mult: float = 1.0,
        turn_mult: float = 1.0,
    ) -> None:
        """
        Advance the snake by `dt` seconds.

        `speed_mult` and `turn_mult` are the hooks power-ups and levels use
        (slow-motion, frenzy, per-level pace) - they scale the cruising speed
        and the maximum steering rate respectively.
        """
        try:
            dt = clamp(float(dt), 0.0, float(C.MAX_DT))

            # Mercy invulnerability ticks down even while dead, so the death
            # animation cannot leave a stale timer behind.
            if self.invuln > 0.0:
                self.invuln = max(0.0, self.invuln - dt)

            if not self.alive or dt <= 0.0:
                self.boosting = False
                return

            speed = self._update_boost(dt, bool(boost), float(speed_mult))
            self.current_speed = speed

            travel = speed * dt
            if travel <= 0.0:
                self._resolve_segments()
                return

            # Sub-step so that neither the turning arc nor the recorded path
            # depends on the frame rate.
            steps = int(travel / _MAX_SUBSTEP_PX) + 1
            if steps > _MAX_SUBSTEPS:
                steps = _MAX_SUBSTEPS
            sub_dt = dt / steps

            turn_limit = self._turn_rate(speed) * max(0.0, float(turn_mult))
            heading_before = self.heading

            for _ in range(steps):
                self._steer(sub_dt, turn_limit)
                step_len = speed * sub_dt
                self.x += math.cos(self.heading) * step_len
                self.y += math.sin(self.heading) * step_len
                self.distance_travelled += step_len
                self._push_path()

            # `bank` is the normalised angular velocity, smoothed so renderers
            # get a stable lean value instead of per-frame noise.
            if turn_limit > 1e-6:
                raw = clamp(_signed_delta(heading_before, self.heading) / (turn_limit * dt),
                            -1.0, 1.0)
            else:
                raw = 0.0
            self.bank += (raw - self.bank) * min(1.0, dt * 10.0)

            self._resolve_segments()
        except Exception:  # pragma: no cover - a bad frame must not kill the game
            pass

    # -- internals ------------------------------------------------------
    def _steer(self, dt: float, turn_limit: float) -> None:
        """Rotate the heading toward the stored target, rate limited."""
        target = self._target
        if target is None or turn_limit <= 0.0:
            return
        tx, ty = target
        # Inside the deadzone the pointer direction is meaningless (a pixel of
        # mouse jitter would flip it), so we simply hold the current heading.
        dz = float(C.MOUSE_DEADZONE)
        if dist_sq(self.x, self.y, tx, ty) <= dz * dz:
            return
        desired = angle_to(self.x, self.y, tx, ty)
        self.heading = approach_angle(self.heading, desired, turn_limit * dt)

    def _turn_rate(self, speed: float) -> float:
        """
        Maximum steering rate for the current speed.

        Slow snakes may pivot tightly (SNAKE_TURN_RATE_SLOW); as speed rises
        toward SNAKE_MAX_SPEED the rate eases down to SNAKE_TURN_RATE, so a
        boosting snake carves wide arcs and boost carries real risk.
        """
        lo, hi = float(C.SNAKE_BASE_SPEED), float(C.SNAKE_MAX_SPEED)
        span = hi - lo
        t = 0.0 if span <= 1e-6 else clamp((speed - lo) / span, 0.0, 1.0)
        return lerp(C.SNAKE_TURN_RATE_SLOW, C.SNAKE_TURN_RATE, t)

    def _update_boost(self, dt: float, want: bool, speed_mult: float) -> float:
        """Run the stamina economy and return the effective speed in px/s."""
        # A fresh boost needs a minimum reserve, but an ongoing one may run the
        # tank all the way down - that avoids a stutter at the threshold.
        if want:
            if self.boosting:
                want = self.boost > 0.0
            else:
                want = self.boost >= float(C.SNAKE_BOOST_MIN_TO_START)
        self.boosting = want

        if want:
            self.boost -= float(C.SNAKE_BOOST_DRAIN) * dt
        else:
            self.boost += float(C.SNAKE_BOOST_REGEN) * dt
        self.boost = clamp(self.boost, 0.0, float(C.SNAKE_BOOST_MAX))
        if self.boost <= 0.0:
            self.boosting = False

        # SNAKE_MAX_SPEED caps the snake's own cruise speed; it is not a cap on
        # the multipliers layered over it.  `speed_mult` (level pace, frenzy,
        # slow) and SNAKE_BOOST_MULT are deliberate design multipliers, so they
        # apply *after* the clamp - which is how boost has always behaved.
        # Clamping before the multiply flattened the top of the difficulty
        # curve: levels 11 and 12 both landed on exactly 460 px/s and played at
        # an identical pace despite speed_mult 1.61 vs 1.70.
        cruise = clamp(self.speed, 0.0, float(C.SNAKE_MAX_SPEED))
        cruise *= max(0.0, speed_mult)
        if self.boosting:
            cruise *= float(C.SNAKE_BOOST_MULT)
        return cruise

    def _push_path(self) -> None:
        """
        Record the head position, newest first.

        When the head has barely moved we slide the newest sample onto it
        instead of appending, which keeps the path free of near-duplicate
        points without ever losing the "path[0] is the head" invariant.
        """
        path = self.path
        if not path:
            path.append((self.x, self.y))
            return
        hx, hy = path[0]
        if dist_sq(hx, hy, self.x, self.y) >= _PATH_MIN_STEP * _PATH_MIN_STEP:
            path.insert(0, (self.x, self.y))
            if len(path) > _MAX_PATH_POINTS:
                del path[_MAX_PATH_POINTS:]
        else:
            path[0] = (self.x, self.y)

    def _resolve_segments(self) -> None:
        """
        Resample `path` into evenly spaced body points and trim the leftovers.

        Walks the path from the head accumulating arc length; whenever the
        accumulated distance passes the next multiple of `spacing` a segment is
        emitted, linearly interpolated between the two surrounding samples.
        The same walk finds the point past which no future frame can need the
        history, and truncates there.
        """
        path = self.path
        out = self.segments          # mutated in place: callers may hold a ref
        out.clear()

        count = int(clamp(float(self.target_length), MIN_LENGTH, MAX_LENGTH))
        if not path:
            out.extend([(self.x, self.y)] * count)
            return

        spacing = self._spacing
        max_arc = count * spacing + self._path_margin

        px, py = path[0]
        acc = 0.0                    # arc length from the head to (px, py)
        needed = spacing             # arc length at which the next segment sits
        n = len(path)
        cut = n
        idx = 1
        while idx < n:
            qx, qy = path[idx]
            dx, dy = qx - px, qy - py
            seg_len = math.hypot(dx, dy)
            if seg_len > 1e-9:
                # One path link can straddle several segment positions when the
                # snake is moving fast, hence the inner loop.
                while len(out) < count and needed <= acc + seg_len:
                    t = (needed - acc) / seg_len
                    out.append((px + dx * t, py + dy * t))
                    needed += spacing
                acc += seg_len
            if acc >= max_arc and len(out) >= count:
                cut = idx + 1
                break
            px, py = qx, qy
            idx += 1

        if cut < n:
            del path[cut:]

        # Not enough history yet (fresh growth, or just after a teleport): the
        # missing segments wait stacked on the oldest recorded point, exactly
        # where a real tail would sit until the head has travelled further.
        if len(out) < count:
            last = path[-1]
            out.extend([last] * (count - len(out)))

    # ------------------------------------------------------------------
    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            "<Snake pos=({:.0f},{:.0f}) heading={:.2f} len={}/{} "
            "speed={:.0f} boost={:.0f} alive={}>".format(
                self.x, self.y, self.heading, len(self.segments),
                self.target_length, self.current_speed, self.boost, self.alive,
            )
        )


def _signed_delta(a: float, b: float) -> float:
    """Shortest signed rotation from angle `a` to angle `b`, in -pi..pi."""
    d = (b - a + math.pi) % (math.pi * 2.0)
    if d < 0.0:
        d += math.pi * 2.0
    return d - math.pi


__all__ = ["Snake", "MIN_LENGTH", "MAX_LENGTH"]
