/**
 * HELP - the "How To Play" screen, a port of `snake/scenes/help_scene.py`.
 *
 * The one screen that has to be *read*, so it trades spectacle for clarity and
 * teaches by showing. Left, a live autonomous demo: a real `Snake` runs the real
 * simulation while a fake cursor orbits the box on a Lissajous path, the snake
 * steered by nothing but "go to the pointer", with a dotted leash drawn between
 * the two. That makes "the head always turns toward your cursor" visible in one
 * glance instead of one sentence.
 *
 * Right, the four controls with drawn icons rather than key names, then the six
 * power-ups as their in-arena runes - names, colours and copy all pulled from
 * the power-up table so this legend can never drift from what the game does -
 * and a short hazard legend under the demo.
 *
 * The cursor path is deliberately a touch faster than the snake. If the two
 * speeds matched, the head would sit on the reticle and the leash - the thing
 * the demo exists to show - would never be visible.
 */

import { Container, Graphics } from "pixi.js";

import type { Game } from "../app/Game";
import { Scene, SCENES } from "../app/Scene";
import * as C from "../core/config";
import { clamp, dist, formatFixed, pulse, TAU, makeRng } from "../core/mathx";
import {
  POWERUP_KINDS,
  POWERUP_TYPES,
  type PowerUpKind,
} from "../core/powerups";
import {
  UI_PANEL_LIGHT,
  UI_WARN,
  UI_WHITE,
  lerpColor,
  shade,
  themeForLevel,
  toHex,
  type RGB,
  type Theme,
} from "../core/palette";
import { Snake } from "../core/snake";
import type { Audio } from "../audio";
import { makeBackground, type Background } from "../gfx/bg";
import { SnakeRenderer } from "../gfx/SnakeRenderer";
import { Button } from "../ui/Button";
import { arcPath, setUiGlow, uiGlowSprite } from "../ui/glow";
import { Panel } from "../ui/panel";
import { Label } from "../ui/text";

/** Layout, all against the fixed 1280x720 canvas. help_scene.py:47-59 */
const PAD = 40;
const TOP = 96;
const DEMO_PANEL = { x: PAD, y: TOP, w: 496, h: 300 };
const HAZARD_PANEL = { x: PAD, y: 412, w: 496, h: 208 };
const CTRL_PANEL = { x: 560, y: TOP, w: 680, h: 216 };
const PU_PANEL = { x: 560, y: 328, w: 680, h: 292 };
const BACK_RECT = {
  x: Math.floor((C.WINDOW_W - C.UI_BUTTON_W) / 2),
  y: 638,
  w: C.UI_BUTTON_W,
  h: C.UI_BUTTON_H,
};
/** Inner play area: the panel minus its caption strip. */
const DEMO_RECT = {
  x: DEMO_PANEL.x + 16,
  y: DEMO_PANEL.y + 40,
  w: DEMO_PANEL.w - 32,
  h: DEMO_PANEL.h - 62,
};

/** Demo tuning. help_scene.py:64-72 */
const DEMO_SPEED = 150.0;
const DEMO_LENGTH = 9;
const DEMO_MAX_LENGTH = 15;
const LISSA_A = 1.25;
const LISSA_B = 0.83;
const LISSA_MARGIN = 46.0;

type ControlRow = readonly [string, string, string];

/**
 * The control rows, per scheme.
 *
 * This screen used to teach a mouse to everybody, including a phone player
 * holding a device with no right button and no Escape key - caught on a real
 * Android device. The rows are chosen from `game.input.scheme` every frame, so
 * pairing a mouse mid-session re-teaches the right thing.
 *
 * `drag` and `offset` differ only in the first row, and the difference is real:
 * on a phone the finger steers by ANGLE from wherever it touched down, on a
 * tablet the aim point leads the finger. Everything after it is shared.
 */
const CONTROLS_MOUSE: ReadonlyArray<ControlRow> = [
  ["move", "MOVE THE MOUSE", "The head always turns toward your cursor."],
  ["right", "HOLD RIGHT BUTTON", "Spend stamina for a burst of speed."],
  ["left", "LEFT CLICK", "Every menu and button is mouse-driven."],
  ["esc", "ESC", "Pause the run - or click PAUSE in the HUD."],
];

const CONTROLS_DRAG: ReadonlyArray<ControlRow> = [
  ["drag", "DRAG ANYWHERE", "The head follows the angle you drag, not the spot."],
  ["boost", "SECOND FINGER", "Spend stamina for a burst of speed."],
  ["tap", "TAP", "Every menu and button takes a tap."],
  ["pause", "PAUSE", "Tap PAUSE in the HUD to stop the run."],
];

const CONTROLS_OFFSET: ReadonlyArray<ControlRow> = [
  ["drag", "TOUCH TO STEER", "The aim point leads your finger, so it stays visible."],
  ...CONTROLS_DRAG.slice(1),
];

/**
 * Every scheme must have the SAME number of rows.
 *
 * The scene is retained-mode: the labels are built once in the constructor and
 * only their text changes per frame. A scheme with a different row count would
 * silently run off the end of `ctrlLabels`.
 */
const CONTROL_ROWS = 4;

function controlsFor(scheme: string): ReadonlyArray<ControlRow> {
  if (scheme === "drag") return CONTROLS_DRAG;
  if (scheme === "offset") return CONTROLS_OFFSET;
  return CONTROLS_MOUSE;
}

/** The one-line summary under the title, and the demo caption. */
const BLURBS: Record<string, { header: string; demo: string }> = {
  mouse: {
    header: "steer with the mouse - everything else is a bonus",
    demo: "this reticle is your mouse - the head chases it",
  },
  drag: {
    header: "drag to steer - everything else is a bonus",
    demo: "the head chases this reticle - your drag angle aims it",
  },
  offset: {
    header: "touch to steer - everything else is a bonus",
    demo: "the head chases this reticle - it leads your finger",
  },
};

const HAZARDS: ReadonlyArray<readonly [string, string, string]> = [
  ["wall", "WALLS", "Solid neon slabs. A touch costs a life."],
  ["mover", "MOVERS & SPINNERS", "Bars that sweep the lane. Time the gap."],
  ["laser", "LASER GATES", "They blink. Cross only while they are dark."],
  ["portal", "PORTALS", "Harmless: dive in, pop out of the twin."],
];

const mix = (a: RGB, b: RGB, t: number): RGB => lerpColor(a, b, t);

/** Normalised glyph outlines, in a -1..1 box. help_scene.py:262-268 */
const SHIELD: ReadonlyArray<readonly [number, number]> = [
  [-0.8, -0.72],
  [0.8, -0.72],
  [0.8, 0.06],
  [0.0, 0.94],
  [-0.8, 0.06],
];
const HOURGLASS: ReadonlyArray<readonly [number, number]> = [
  [-0.72, -0.88],
  [0.72, -0.88],
  [0.12, 0.0],
  [0.72, 0.88],
  [-0.72, 0.88],
  [-0.12, 0.0],
];
const BOLT: ReadonlyArray<readonly [number, number]> = [
  [0.16, -0.96],
  [-0.66, 0.14],
  [-0.1, 0.14],
  [-0.3, 0.96],
  [0.62, -0.18],
  [0.06, -0.18],
];
const GHOST_TAIL: ReadonlyArray<readonly [number, number]> = [
  [0.74, 0.42],
  [0.44, 0.92],
  [0.15, 0.46],
  [-0.15, 0.92],
  [-0.44, 0.46],
  [-0.74, 0.92],
];

function polyPath(
  g: Graphics,
  cx: number,
  cy: number,
  s: number,
  norm: ReadonlyArray<readonly [number, number]>,
  close: boolean,
): void {
  const first = norm[0];
  if (!first) return;
  g.moveTo(cx + first[0] * s, cy + first[1] * s);
  for (let i = 1; i < norm.length; i++) {
    const p = norm[i]!;
    g.lineTo(cx + p[0] * s, cy + p[1] * s);
  }
  if (close) g.closePath();
}

export class HelpScene extends Scene {
  /**
   * Which control scheme to teach, read every frame rather than cached.
   *
   * `InputManager.refreshScheme` can change it on a rotation (a tablet-sized
   * window and a phone-sized one steer differently), and a mouse paired to a
   * tablet flips it outright - so a value latched in the constructor would
   * teach the wrong controls for the rest of the session.
   */
  private get scheme(): string {
    return this.game.input?.scheme ?? "mouse";
  }

  readonly root = new Container();

  private readonly sound: Audio | null;
  private theme: Theme = themeForLevel(0);
  private t = 0;

  private background: Background | null = null;
  private bgStyle = "";
  private readonly bgLayer = new Container();

  private readonly back: Button;

  private readonly panels: Panel[] = [];
  private readonly titleMarks = new Graphics();
  private readonly panelTitles: Label[] = [];
  private readonly header: Label[] = [];

  private readonly well = new Graphics();
  private readonly wellClip = new Graphics();
  private readonly demoLayer = new Container();
  private readonly leash = new Graphics();
  private readonly orbGlow;
  private readonly orbCore = new Graphics();
  private readonly reticle = new Graphics();
  private readonly reticleGlow;
  private readonly demoView = new SnakeRenderer();
  private readonly demoCaption: Label;

  private readonly icons = new Graphics();
  private readonly iconGlows: ReturnType<typeof uiGlowSprite>[] = [];
  private readonly ctrlLabels: Label[] = [];
  private readonly puLabels: Label[] = [];
  private readonly hazardLabels: Label[] = [];
  private readonly keyCapLabel: Label;

  private snake: Snake | null = null;
  private cursorX = DEMO_RECT.x + DEMO_RECT.w * 0.5;
  private cursorY = DEMO_RECT.y + DEMO_RECT.h * 0.5;
  private foodX = this.cursorX;
  private foodY = this.cursorY;
  private foodPop = 0;
  private foodAge = 0;
  private lissaPhase = 0;
  private rng = makeRng(7);

  constructor(game: Game, sound: Audio | null = null) {
    super(game);
    this.sound = sound;
    const fonts = game.fonts;

    this.back = new Button(fonts, BACK_RECT, "BACK", { style: "primary", font: fonts.h2 });

    this.orbGlow = uiGlowSprite(26, UI_WHITE, 0);
    this.reticleGlow = uiGlowSprite(20, UI_WHITE, 0);

    for (let i = 0; i < 4; i++) {
      this.panels.push(new Panel());
      this.panelTitles.push(new Label(fonts, fonts.small));
    }
    for (let i = 0; i < 4; i++) this.header.push(new Label(fonts, i === 0 ? fonts.h1 : fonts.small));
    this.header[3] = new Label(fonts, fonts.tiny);

    this.demoCaption = new Label(fonts, fonts.tiny);
    this.keyCapLabel = new Label(fonts, fonts.tiny);

    // Two labels per control and hazard row, three per power-up.
    for (let i = 0; i < CONTROL_ROWS * 2; i++) {
      this.ctrlLabels.push(new Label(fonts, i % 2 === 0 ? fonts.small : fonts.tiny));
    }
    for (let i = 0; i < HAZARDS.length * 2; i++) {
      this.hazardLabels.push(new Label(fonts, i % 2 === 0 ? fonts.small : fonts.tiny));
    }
    for (let i = 0; i < 6 * 3; i++) {
      this.puLabels.push(new Label(fonts, i % 3 === 0 ? fonts.small : fonts.tiny));
    }
    // One glow per icon: four controls, four hazards, six runes.
    for (let i = 0; i < 14; i++) this.iconGlows.push(uiGlowSprite(22, UI_WHITE, 0));

    this.wellClip.rect(DEMO_RECT.x, DEMO_RECT.y, DEMO_RECT.w, DEMO_RECT.h).fill({
      color: 0xffffff,
    });
    this.demoLayer.mask = this.wellClip;
    this.demoLayer.addChild(
      this.leash,
      this.orbGlow,
      this.orbCore,
      this.demoView.container,
      this.reticleGlow,
      this.reticle,
    );

    this.root.addChild(this.bgLayer);
    for (const h of this.header) this.root.addChild(h);
    for (const p of this.panels) this.root.addChild(p);
    this.root.addChild(this.titleMarks);
    for (const l of this.panelTitles) this.root.addChild(l);
    this.root.addChild(this.well, this.wellClip, this.demoLayer, this.demoCaption);
    for (const s of this.iconGlows) this.root.addChild(s);
    this.root.addChild(this.icons, this.keyCapLabel);
    for (const l of this.ctrlLabels) this.root.addChild(l);
    for (const l of this.puLabels) this.root.addChild(l);
    for (const l of this.hazardLabels) this.root.addChild(l);
    this.root.addChild(this.back.root);
  }

  // -------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------

  override onEnter(): void {
    // Full reset: scene instances are cached and reused by the shell.
    this.t = 0;
    this.theme = themeForLevel(this.game.levelIndex);
    this.ensureBackground();

    this.rng = makeRng(7);
    this.lissaPhase = 0;
    const c = this.cursorTarget(0);
    this.cursorX = c.x;
    this.cursorY = c.y;
    this.snake = new Snake(
      DEMO_RECT.x + DEMO_RECT.w * 0.5,
      DEMO_RECT.y + DEMO_RECT.h * 0.5,
      0,
      DEMO_LENGTH,
    );
    this.snake.speed = DEMO_SPEED;
    this.foodPop = 0;
    this.respawnFood();
  }

  override onExit(): void {
    // Drop the demo so a re-entry always starts from a clean pose.
    this.snake = null;
    this.background?.destroy();
    this.background = null;
    this.bgStyle = "";
  }

  override onResize(): void {
    this.background?.destroy();
    this.background = null;
    this.bgStyle = "";
    this.ensureBackground();
  }

  /** (Re)build the scrolling backdrop when the active theme changed. */
  private ensureBackground(): void {
    const style = this.theme.bgStyle;
    if (this.background && style === this.bgStyle) return;
    const renderer = this.game.app?.renderer;
    if (!renderer) return;
    this.background?.destroy();
    try {
      this.background = makeBackground(
        style,
        this.theme,
        { ...this.game.viewport.overscan },
        renderer,
      );
      this.bgLayer.addChild(this.background.root);
      this.bgStyle = style;
    } catch (err) {
      console.warn("[help] background unavailable", err);
      this.background = null;
    }
  }

  private goBack(): void {
    this.sound?.play("click");
    if (this.game.registeredScenes().includes(SCENES.MENU)) {
      this.game.switchScene(SCENES.MENU);
    }
  }

  // -------------------------------------------------------------------
  // frame
  // -------------------------------------------------------------------

  override update(dt: number): void {
    const d = clamp(dt, 0, C.MAX_DT);
    this.t += d;

    let fired = false;
    for (const ev of this.game.uiEvents) {
      if (this.back.handlePointer(ev)) fired = true;
    }
    for (const ev of this.game.keyEvents) {
      if (ev.type !== "down" || ev.repeat) continue;
      if (["Escape", "Backspace", "Enter", " ", "h"].includes(ev.key)) fired = true;
    }

    const was = this.back.hovered;
    this.back.update(d, this.game.pointer);
    if (this.back.hovered && !was) this.sound?.play("hover");

    this.background?.update(d, { x: this.cursorX, y: this.cursorY });
    this.updateDemo(d);
    this.draw();

    if (fired) this.goBack();
  }

  /** Lissajous figure inset from the demo frame - a lazy figure-of-eight. */
  private cursorTarget(t: number): { x: number; y: number } {
    const rx = DEMO_RECT.w * 0.5 - LISSA_MARGIN;
    const ry = DEMO_RECT.h * 0.5 - LISSA_MARGIN;
    return {
      x: DEMO_RECT.x + DEMO_RECT.w * 0.5 + Math.cos(t * LISSA_A) * rx,
      y: DEMO_RECT.y + DEMO_RECT.h * 0.5 + Math.sin(t * LISSA_B) * ry,
    };
  }

  /**
   * Drop the demo orb a couple of seconds ahead on the pointer's own path.
   *
   * The snake only ever chases the reticle, so seeding the orb where the
   * reticle is *about* to be keeps the demo eating at a steady clip instead of
   * wandering past a stationary pellet.
   */
  private respawnFood(): void {
    const pad = 26;
    this.foodAge = 0;
    const ahead = 1.2 + this.rng() * 1.2;
    const p = this.cursorTarget(this.lissaPhase + ahead);
    const x = p.x + (this.rng() - 0.5) * 20;
    const y = p.y + (this.rng() - 0.5) * 20;
    this.foodX = clamp(x, DEMO_RECT.x + pad, DEMO_RECT.x + DEMO_RECT.w - pad);
    this.foodY = clamp(y, DEMO_RECT.y + pad, DEMO_RECT.y + DEMO_RECT.h - pad);
  }

  private updateDemo(dt: number): void {
    const snake = this.snake;
    if (!snake) return;
    this.lissaPhase += dt;
    const c = this.cursorTarget(this.lissaPhase);
    this.cursorX = c.x;
    this.cursorY = c.y;
    this.foodPop = Math.max(0, this.foodPop - dt * 2.2);
    this.foodAge += dt;

    // The whole point: the snake is steered by nothing except "go to the
    // pointer", exactly like the player's is.
    snake.setTarget(this.cursorX, this.cursorY);
    snake.update(dt);

    let head = snake.headPos();
    if (dist(head.x, head.y, this.foodX, this.foodY) < C.FOOD_RADIUS + 14) {
      this.foodPop = 1;
      // `targetLength` is the growth goal; the resolved body length is derived,
      // so the cap is checked on the goal.
      if (snake.targetLength < DEMO_MAX_LENGTH) snake.grow(1);
      else snake.shrink(2);
      this.respawnFood();
    } else if (this.foodAge > 5) {
      // The head cuts corners, so an orb the pointer swung past can be left
      // stranded. Re-seed rather than let the demo go static.
      this.respawnFood();
    }

    // A stall could leave the head outside the box; nudge it back without a pop.
    head = snake.headPos();
    const nx = clamp(head.x, DEMO_RECT.x + 6, DEMO_RECT.x + DEMO_RECT.w - 6);
    const ny = clamp(head.y, DEMO_RECT.y + 6, DEMO_RECT.y + DEMO_RECT.h - 6);
    if (nx !== head.x || ny !== head.y) snake.teleport(nx, ny);
  }

  // -------------------------------------------------------------------
  // draw
  // -------------------------------------------------------------------

  private draw(): void {
    const theme = this.theme;
    const t = this.t;

    this.titleMarks.clear();
    this.icons.clear();

    this.drawHeader(theme);
    this.drawPanelChrome(theme);
    this.drawDemo(theme, t);
    this.drawControls(theme, t);
    this.drawPowerups(theme, t);
    this.drawHazards(theme, t);
    this.back.draw(theme, t);
  }

  private drawHeader(theme: Theme): void {
    const rows: Array<[string, number, number, "left" | "right", RGB]> = [
      ["HOW TO PLAY", PAD, 18, "left", mix(theme.accent, UI_WHITE, 0.35)],
      [
        (BLURBS[this.scheme] ?? BLURBS["mouse"]!).header,
        PAD + 4,
        64,
        "left",
        theme.textDim,
      ],
      [C.GAME_TITLE, C.WINDOW_W - PAD, 26, "right", shade(theme.accent2, 0.9)],
      [`v${C.VERSION}`, C.WINDOW_W - PAD, 50, "right", shade(theme.textDim, 0.8)],
    ];
    rows.forEach(([text, x, y, align, col], i) => {
      const l = this.header[i]!;
      l.set(text);
      l.setColor(col);
      l.place(x, y, align);
    });
  }

  /** Caption strip shared by every panel: a tick mark plus small caps. */
  private drawPanelChrome(theme: Theme): void {
    const specs: Array<[typeof DEMO_PANEL, string, number, number]> = [
      [DEMO_PANEL, "THE SNAKE FOLLOWS YOUR POINTER", 214, 0.35],
      [CTRL_PANEL, "CONTROLS", 214, 0.25],
      [PU_PANEL, "POWER-UPS", 214, 0.25],
      [HAZARD_PANEL, "HAZARDS", 214, 0.25],
    ];
    specs.forEach(([rect, label, alpha, glow], i) => {
      const p = this.panels[i]!;
      p.setRect(rect.x, rect.y, rect.w, rect.h);
      p.setStyle(theme.accent, alpha, true, glow);

      this.titleMarks
        .moveTo(rect.x + 16, rect.y + 26)
        .lineTo(rect.x + 16, rect.y + 12)
        .stroke({ color: toHex(theme.accent), width: 3 });

      const l = this.panelTitles[i]!;
      l.set(label);
      l.setColor(mix(theme.accent, UI_WHITE, 0.4));
      l.place(rect.x + 26, rect.y + 11);
    });
  }

  private drawDemo(theme: Theme, t: number): void {
    // Inner play box: a darker well with a faint lattice, so it reads as a
    // scaled-down play field.
    const g = this.well.clear();
    g.rect(DEMO_RECT.x, DEMO_RECT.y, DEMO_RECT.w, DEMO_RECT.h).fill({
      color: toHex(shade(theme.bgBottom, 1.1)),
      alpha: 218 / 255,
    });
    const lattice = toHex(theme.grid);
    for (let gx = 0; gx < DEMO_RECT.w; gx += 32) {
      g.moveTo(DEMO_RECT.x + gx, DEMO_RECT.y)
        .lineTo(DEMO_RECT.x + gx, DEMO_RECT.y + DEMO_RECT.h)
        .stroke({ color: lattice, width: 1, alpha: 60 / 255 });
    }
    for (let gy = 0; gy < DEMO_RECT.h; gy += 32) {
      g.moveTo(DEMO_RECT.x, DEMO_RECT.y + gy)
        .lineTo(DEMO_RECT.x + DEMO_RECT.w, DEMO_RECT.y + gy)
        .stroke({ color: lattice, width: 1, alpha: 60 / 255 });
    }
    g.roundRect(DEMO_RECT.x, DEMO_RECT.y, DEMO_RECT.w, DEMO_RECT.h, 6).stroke({
      color: lattice,
      width: 1,
    });

    const snake = this.snake;
    this.demoLayer.visible = snake !== null;
    if (!snake) return;
    const head = snake.headPos();

    // Marching-ants leash, sliding toward the pointer.
    this.drawLeash(head.x, head.y, this.cursorX, this.cursorY, theme.accent, -t * 34);

    // The demo orb, built from the same primitives the arena's orbs use.
    const pop = 1 + 0.35 * this.foodPop;
    const rr = C.FOOD_RADIUS * pop;
    this.orbGlow.position.set(this.foodX, this.foodY);
    setUiGlow(this.orbGlow, rr * 2.9, theme.food, 0.55 + 0.35 * pulse(t, C.FOOD_PULSE_SPEED));
    this.orbCore
      .clear()
      .circle(this.foodX, this.foodY, rr)
      .fill({ color: toHex(theme.food) })
      .circle(this.foodX, this.foodY, rr * 0.45)
      .fill({ color: toHex(mix(theme.food, UI_WHITE, 0.7)) });

    this.demoView.draw(snake, theme, t, {});
    this.drawFakeCursor(this.cursorX, this.cursorY, theme, t);

    this.demoCaption.set((BLURBS[this.scheme] ?? BLURBS["mouse"]!).demo);
    this.demoCaption.setColor(shade(theme.textDim, 1.05));
    this.demoCaption.place(
      DEMO_PANEL.x + DEMO_PANEL.w * 0.5,
      DEMO_RECT.y + DEMO_RECT.h + 2,
      "center",
    );
  }

  /** A marching-ants leash; `phase` slides the dashes toward the target. */
  private drawLeash(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    color: RGB,
    phase: number,
  ): void {
    const g = this.leash.clear();
    const total = dist(ax, ay, bx, by);
    if (total < 4) return;
    const step = 11;
    const ux = (bx - ax) / total;
    const uy = (by - ay) / total;
    let d = ((phase % step) + step) % step;
    while (d < total) {
      const f = d / total; // fade in toward the pointer end
      g.circle(ax + ux * d, ay + uy * d, 1 + f * 1.6).fill({
        color: toHex(shade(color, 0.25 + 0.55 * f)),
      });
      d += step;
    }
  }

  /**
   * A miniature of the real reticle, so the demo reads as "this dot is your
   * mouse" without a caption doing the work.
   */
  private drawFakeCursor(cx: number, cy: number, theme: Theme, t: number): void {
    const g = this.reticle.clear();
    const r = 11 + 1.2 * pulse(t, 3.0);
    this.reticleGlow.position.set(cx, cy);
    setUiGlow(this.reticleGlow, 20, theme.accent, 0.5);

    const spin = t * 1.35;
    const tick = toHex(mix(theme.accent, UI_WHITE, 0.3));
    // pygame's arc is y-up, so the angles are negated here.
    for (let k = 0; k < 3; k++) {
      const a0 = spin + (k * TAU) / 3;
      arcPath(g, cx, cy, r, -(a0 + 0.85), -a0).stroke({ color: tick, width: 2 });
    }
    const spur = toHex(shade(theme.accent2, 0.85));
    for (let k = 0; k < 4; k++) {
      const ang = spin * -0.5 + k * (Math.PI * 0.5);
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      g.moveTo(cx + ca * (r + 3), cy + sa * (r + 3))
        .lineTo(cx + ca * (r + 8), cy + sa * (r + 8))
        .stroke({ color: spur, width: 1 });
    }
    g.circle(cx, cy, 2).fill({ color: toHex(UI_WHITE) });
  }

  private drawControls(theme: Theme, t: number): void {
    const rowH = 42;
    const top = CTRL_PANEL.y + 44;
    this.keyCapLabel.visible = false;
    controlsFor(this.scheme).forEach(([key, caption, blurb], i) => {
      const ry = top + i * rowH;
      const icx = CTRL_PANEL.x + 42;
      const icy = ry + 20;
      if (key === "esc") this.drawKeyIcon(icx, icy, theme, "ESC", t, i);
      else if (key === "pause") this.drawKeyIcon(icx, icy, theme, "II", t, i);
      else if (key === "drag" || key === "boost" || key === "tap") {
        this.drawTouchIcon(icx, icy, theme, key, t, i);
      } else this.drawMouseIcon(icx, icy, theme, key, t, i);

      const cap = this.ctrlLabels[i * 2]!;
      cap.set(caption);
      cap.setColor(mix(theme.accent, UI_WHITE, 0.5));
      cap.place(CTRL_PANEL.x + 78, ry);

      const sub = this.ctrlLabels[i * 2 + 1]!;
      sub.set(blurb);
      sub.setColor(theme.textDim);
      sub.place(CTRL_PANEL.x + 78, ry + 20);
    });
  }

  /**
   * A 22x32 mouse body. `lit` picks which half of the shell glows, or draws
   * the motion arcs.
   */
  private drawMouseIcon(
    cx: number,
    cy: number,
    theme: Theme,
    lit: string,
    t: number,
    slot: number,
  ): void {
    const g = this.icons;
    const dim = shade(theme.textDim, 0.9);
    const w = 22;
    const h = 32;
    const bx = cx - w * 0.5;
    const by = cy - h * 0.5;
    const glowSprite = this.iconGlows[slot]!;
    glowSprite.visible = false;

    if (lit === "left" || lit === "right") {
      const hx = lit === "right" ? cx : bx;
      const glowC = lit === "right" ? UI_WARN : theme.accent;
      glowSprite.position.set(hx + w * 0.25, by + h * 0.25);
      setUiGlow(glowSprite, 16, glowC, 0.55 + 0.35 * pulse(t, 3.2));
      // Only the outer corner is rounded, matching the shell's silhouette.
      const r = 10;
      g.roundRect(hx, by, w * 0.5, h * 0.5, r).fill({
        color: toHex(mix(glowC, UI_WHITE, 0.25)),
      });
    }

    g.roundRect(bx, by, w, h, 10).stroke({
      color: toHex(mix(dim, UI_WHITE, 0.35)),
      width: 2,
    });
    g.moveTo(cx, by + 2)
      .lineTo(cx, cy)
      .stroke({ color: toHex(dim), width: 2 });
    g.moveTo(bx + 2, cy)
      .lineTo(bx + w - 2, cy)
      .stroke({ color: toHex(dim), width: 1 });

    if (lit === "move") {
      // Two arcs either side, sliding outward: the universal "it moves" cue.
      const wobble = 2 * Math.sin(t * 3.4);
      for (const side of [-1, 1]) {
        for (let k = 0; k < 2; k++) {
          const x = cx + side * (w * 0.5 + 6 + k * 5) + side * wobble;
          const col = toHex(shade(theme.accent, 0.9 - 0.35 * k));
          const a0 = side > 0 ? -0.7 : Math.PI - 0.7;
          const a1 = side > 0 ? 0.7 : Math.PI + 0.7;
          arcPath(g, x, cy, 9, a0, a1).stroke({ color: col, width: 2 });
        }
      }
    }
  }

  /**
   * A touch contact: the phone counterpart of the mouse body.
   *
   * "drag" deliberately draws what the scheme actually does - an anchor ring
   * where the finger went down, a contact dot away from it, and the line
   * between them - because it is the ANGLE of that line that steers and the
   * distance means nothing. A picture of a finger would not say that.
   */
  private drawTouchIcon(
    cx: number,
    cy: number,
    theme: Theme,
    kind: string,
    t: number,
    slot: number,
  ): void {
    const g = this.icons;
    const dim = shade(theme.textDim, 0.9);
    const glowSprite = this.iconGlows[slot]!;
    glowSprite.visible = false;

    if (kind === "drag") {
      const a = t * 1.6;
      const fx = cx + Math.cos(a) * 10;
      const fy = cy + Math.sin(a) * 10;
      glowSprite.position.set(fx, fy);
      setUiGlow(glowSprite, 15, theme.accent, 0.5 + 0.25 * pulse(t, 3.0));
      g.circle(cx, cy, 5).stroke({ color: toHex(mix(dim, UI_WHITE, 0.3)), width: 2 });
      g.moveTo(cx, cy)
        .lineTo(fx, fy)
        .stroke({ color: toHex(shade(theme.accent, 0.85)), width: 2 });
      g.circle(fx, fy, 5.5).fill({ color: toHex(mix(theme.accent, UI_WHITE, 0.35)) });
      return;
    }

    if (kind === "boost") {
      glowSprite.position.set(cx + 8, cy);
      setUiGlow(glowSprite, 15, UI_WARN, 0.5 + 0.35 * pulse(t, 3.2));
      g.circle(cx - 8, cy, 5.5).fill({ color: toHex(mix(dim, UI_WHITE, 0.45)) });
      g.circle(cx + 8, cy, 5.5).fill({ color: toHex(mix(UI_WARN, UI_WHITE, 0.3)) });
      return;
    }

    // "tap": one contact, with rings leaving it.
    glowSprite.position.set(cx, cy);
    setUiGlow(glowSprite, 14, theme.accent, 0.35 + 0.2 * pulse(t, 2.6));
    g.circle(cx, cy, 5.5).fill({ color: toHex(mix(theme.accent, UI_WHITE, 0.35)) });
    for (let k = 0; k < 2; k++) {
      const f = (t * 0.9 + k * 0.5) % 1;
      g.circle(cx, cy, 7 + f * 9).stroke({
        color: toHex(shade(theme.accent, 0.9 * (1 - f))),
        width: 2,
      });
    }
  }

  /** A little keycap with a label engraved on it. */
  private drawKeyIcon(
    cx: number,
    cy: number,
    theme: Theme,
    label: string,
    t: number,
    slot: number,
  ): void {
    const g = this.icons;
    const w = 46;
    const h = 30;
    const glowSprite = this.iconGlows[slot]!;
    glowSprite.position.set(cx, cy);
    setUiGlow(glowSprite, 22, theme.accent2, 0.22 + 0.12 * pulse(t, 2.2));

    g.roundRect(cx - w * 0.5, cy - h * 0.5, w, h, 7).fill({
      color: toHex(UI_PANEL_LIGHT),
    });
    g.roundRect(cx - w * 0.5, cy - h * 0.5, w, h, 7).stroke({
      color: toHex(mix(theme.accent2, UI_WHITE, 0.25)),
      width: 2,
    });

    this.keyCapLabel.visible = true;
    this.keyCapLabel.set(label);
    this.keyCapLabel.setColor(UI_WHITE);
    this.keyCapLabel.setShadow(false);
    this.keyCapLabel.place(cx, cy - 7, "center");
  }

  private drawPowerups(theme: Theme, t: number): void {
    const colW = Math.floor((PU_PANEL.w - 32) / 2);
    const rowH = 80;
    const top = PU_PANEL.y + 46;
    POWERUP_KINDS.slice(0, 6).forEach((kind, i) => {
      const info = POWERUP_TYPES[kind as PowerUpKind];
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = PU_PANEL.x + 16 + col * colW;
      const y = top + row * rowH;

      this.drawRune(kind, x + 30, y + 30, 17, theme, t, 8 + i);

      const name = this.puLabels[i * 3]!;
      name.set(info.name.toUpperCase());
      name.setColor(mix(info.color, UI_WHITE, 0.35));
      name.place(x + 62, y + 8);

      const desc = this.puLabels[i * 3 + 1]!;
      desc.set(info.desc);
      desc.setColor(theme.textDim);
      desc.place(x + 62, y + 30);

      const secs = this.puLabels[i * 3 + 2]!;
      const has = info.duration > 0;
      secs.visible = has;
      if (has) {
        secs.set(`${formatFixed(info.duration, 0)}s`);
        secs.setColor(shade(theme.textDim, 0.75));
        secs.place(x + 62, y + 48);
      }
    });
  }

  /** Halo, counter-rotating hexagram, core and emblem: the arena rune, small. */
  private drawRune(
    kind: string,
    cx: number,
    cy: number,
    r: number,
    theme: Theme,
    t: number,
    slot: number,
  ): void {
    const g = this.icons;
    const info = POWERUP_TYPES[kind as PowerUpKind];
    const col = info ? info.color : theme.accent2;
    const ringCol = mix(col, theme.accent, 0.28);

    const glowSprite = this.iconGlows[slot]!;
    glowSprite.position.set(cx, cy);
    setUiGlow(glowSprite, r * 2.4, col, 0.45 + 0.12 * pulse(t, 2.6));

    const spin = t * 0.85;
    const triR = r * 1.34;
    for (const sense of [1, -1]) {
      const a0 = spin * sense + (sense > 0 ? 0 : Math.PI / 3);
      const pts: Array<[number, number]> = [];
      for (let k = 0; k < 3; k++) {
        const a = a0 + (k * TAU) / 3;
        pts.push([Math.cos(a) * triR, Math.sin(a) * triR]);
      }
      polyPath(g, cx, cy, 1, pts, true);
      g.stroke({ color: toHex(shade(ringCol, 0.55)), width: Math.max(1, r * 0.13) });
    }

    g.circle(cx, cy, Math.max(2, r * 0.55)).fill({ color: toHex(shade(col, 0.3)) });
    this.drawGlyph(kind, mix(col, UI_WHITE, 0.55), cx, cy, r * 0.78);
  }

  /** Stroke one power-up emblem, centred on (cx, cy) with radius `s`. */
  private drawGlyph(kind: string, col: RGB, cx: number, cy: number, s: number): void {
    const g = this.icons;
    const c = toHex(col);
    const w = Math.max(2, s * 0.22);

    switch (kind) {
      case "magnet": {
        // A horseshoe: the arc is y-up in the source, so it is mirrored here.
        arcPath(g, cx, cy - 0.1 * s, 0.92 * s, Math.PI, TAU).stroke({ color: c, width: w });
        for (const sx of [-0.92, 0.92]) {
          g.moveTo(cx + sx * s, cy - 0.1 * s)
            .lineTo(cx + sx * s, cy + 0.74 * s)
            .stroke({ color: c, width: w });
          g.moveTo(cx + sx * s * 1.28, cy + 0.74 * s)
            .lineTo(cx + sx * s * 0.56, cy + 0.74 * s)
            .stroke({ color: c, width: Math.max(2, w * 0.9) });
        }
        break;
      }
      case "shield":
        polyPath(g, cx, cy, s, SHIELD, true);
        g.stroke({ color: c, width: w });
        g.moveTo(cx, cy - 0.36 * s)
          .lineTo(cx, cy + 0.46 * s)
          .stroke({ color: c, width: Math.max(1, w - 1) });
        break;
      case "slow":
        polyPath(g, cx, cy, s, HOURGLASS, true);
        g.stroke({ color: c, width: w });
        g.circle(cx, cy + 0.52 * s, Math.max(2, s * 0.14)).fill({ color: c });
        break;
      case "double":
        for (const scale of [0.94, 0.48]) {
          const dia: Array<[number, number]> = [
            [0, -scale],
            [scale, 0],
            [0, scale],
            [-scale, 0],
          ];
          polyPath(g, cx, cy, s, dia, true);
          g.stroke({ color: c, width: w });
        }
        break;
      case "ghost": {
        const outline: Array<[number, number]> = [];
        for (let i = 0; i <= 12; i++) {
          const a = (i * Math.PI) / 12;
          outline.push([Math.cos(a) * 0.74, -Math.sin(a) * 0.74]);
        }
        for (let i = GHOST_TAIL.length - 1; i >= 0; i--) {
          outline.push([GHOST_TAIL[i]![0], GHOST_TAIL[i]![1]]);
        }
        polyPath(g, cx, cy, s, outline, true);
        g.stroke({ color: c, width: w });
        for (const sx of [-0.3, 0.3]) {
          g.circle(cx + sx * s, cy - 0.16 * s, Math.max(2, s * 0.13)).fill({ color: c });
        }
        break;
      }
      case "frenzy":
        polyPath(g, cx, cy, s, BOLT, true);
        g.fill({ color: c });
        break;
      default:
        g.circle(cx, cy, Math.max(2, s * 0.7)).stroke({ color: c, width: w });
        break;
    }
  }

  private drawHazards(theme: Theme, t: number): void {
    const rowH = 42;
    const top = HAZARD_PANEL.y + 40;
    HAZARDS.forEach(([key, caption, blurb], i) => {
      const ry = top + i * rowH;
      this.drawHazardIcon(key, HAZARD_PANEL.x + 40, ry + 19, theme, t, 4 + i);
      const col = key === "portal" ? theme.accent2 : theme.hazard;

      const cap = this.hazardLabels[i * 2]!;
      cap.set(caption);
      cap.setColor(mix(col, UI_WHITE, 0.45));
      cap.place(HAZARD_PANEL.x + 70, ry);

      const sub = this.hazardLabels[i * 2 + 1]!;
      sub.set(blurb);
      sub.setColor(theme.textDim);
      sub.place(HAZARD_PANEL.x + 70, ry + 20);
    });
  }

  /** Tiny vector stand-ins for the four families of obstacle. */
  private drawHazardIcon(
    key: string,
    cx: number,
    cy: number,
    theme: Theme,
    t: number,
    slot: number,
  ): void {
    const g = this.icons;
    const hz = theme.hazard;
    const glowSprite = this.iconGlows[slot]!;

    if (key === "wall") {
      glowSprite.position.set(cx, cy);
      setUiGlow(glowSprite, 20, hz, 0.35);
      g.roundRect(cx - 15, cy - 8, 30, 16, 4).fill({ color: toHex(shade(hz, 0.55)) });
      g.roundRect(cx - 15, cy - 8, 30, 16, 4).stroke({
        color: toHex(mix(hz, UI_WHITE, 0.35)),
        width: 2,
      });
    } else if (key === "mover") {
      const ang = t * 1.5;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      glowSprite.position.set(cx, cy);
      setUiGlow(glowSprite, 20, hz, 0.35);
      g.moveTo(cx - ca * 15, cy - sa * 15)
        .lineTo(cx + ca * 15, cy + sa * 15)
        .stroke({ color: toHex(mix(hz, UI_WHITE, 0.3)), width: 5 });
      g.circle(cx, cy, 2).fill({ color: toHex(UI_WHITE) });
    } else if (key === "laser") {
      const on = pulse(t, 4.0) > 0.45;
      const col = toHex(on ? mix(hz, UI_WHITE, 0.4) : shade(hz, 0.25));
      glowSprite.position.set(cx, cy);
      if (on) setUiGlow(glowSprite, 20, hz, 0.55);
      else glowSprite.visible = false;
      for (const sy of [-13, 13]) {
        g.circle(cx, cy + sy, 3).fill({ color: toHex(shade(hz, 0.8)) });
      }
      const step = on ? 4 : 8;
      for (let y = -11; y < 12; y += step) {
        g.moveTo(cx, cy + y)
          .lineTo(cx, cy + Math.min(11, y + step - 2))
          .stroke({ color: col, width: 3 });
      }
    } else {
      const col = theme.accent2;
      glowSprite.position.set(cx, cy);
      setUiGlow(glowSprite, 20, col, 0.4);
      [-8, 8].forEach((ox, k) => {
        const rr = 9 - 2 * k;
        g.circle(cx + ox, cy, rr).stroke({
          color: toHex(mix(col, UI_WHITE, 0.3 * k)),
          width: 2,
        });
      });
      g.moveTo(cx - 4, cy)
        .lineTo(cx + 4, cy)
        .stroke({ color: toHex(shade(col, 0.7)), width: 1 });
    }
  }
}
