/**
 * The title screen - a port of `snake/scenes/menu.py`.
 *
 * This is the first thing anybody sees, so nothing on it sits still: the twelve
 * level themes cycle on a slow timer with a real background cross-fading behind
 * each one, an idle demo snake steers itself around and deliberately doubles
 * back on its own body every few seconds so the constant-radius hairpin is the
 * first thing the game shows you, the wordmark carries an additive bloom and a
 * breathing chromatic split, and the buttons fly in staggered from alternating
 * sides on every entry.
 *
 * The menu only **routes**. It never starts a run itself - the mode picker owns
 * story-vs-free and the difficulty, and LEVELS forces free play on the way out.
 *
 * The cross-fade weight is quantised to eight steps. In the Python that is to
 * stop a continuously varying colour minting a fresh cached surface every
 * frame; here tints are free, but it is kept because the blended theme is what
 * the wordmark art is rebuilt from, and that *is* a raster.
 */

import { Container, Sprite } from "pixi.js";

import type { Game } from "../app/Game";
import { Scene, SCENES, type SceneEnterArgs } from "../app/Scene";
import * as C from "../core/config";
import { clamp, dist, easeOutBack, pulse } from "../core/mathx";
import { LEVEL_COUNT } from "../core/level";
import { getDifficulty, type Difficulty } from "../core/difficulty";
import {
  THEMES,
  UI_GOLD,
  UI_WHITE,
  blendThemes,
  lerpColor,
  shade,
  toHex,
  type Theme,
} from "../core/palette";
import type { SaveData } from "../core/save";
import { Snake } from "../core/snake";
import { CHAPTERS, getBeat, getChapter } from "../core/story";
import type { Audio } from "../audio";
import { makeBackground, type Background } from "../gfx/bg";
import { SnakeRenderer } from "../gfx/SnakeRenderer";
import { makeRng } from "../core/mathx";
import { Bar } from "../ui/bar";
import { Button, type ButtonStyle } from "../ui/Button";
import { uiGlowSprite, setUiGlow } from "../ui/glow";
import { Panel } from "../ui/panel";
import { Label, glyphTexture } from "../ui/text";

/** Seconds one theme holds the screen before the next takes over. menu.py:63 */
const THEME_PERIOD = 11.0;
/** Seconds of cross-fade at the end of each period. menu.py:65 */
const THEME_FADE = 2.4;
/** The cross-fade weight is snapped onto this many steps. menu.py:70 */
const THEME_BLEND_STEPS = 8;

/** Button stack geometry. menu.py:73-78 */
const BUTTON_TOP = 336;
const BUTTON_PITCH = C.UI_BUTTON_H + 13;
const BUTTON_ENTRANCE = 0.52;
const BUTTON_STAGGER = 0.075;
const BUTTON_SLIDE = 190.0;

const TITLE_MAX_W = C.WINDOW_W - 200;

/** Demo snake tuning. menu.py:84-90 */
const DEMO_MARGIN = 96.0;
const DEMO_SPEED = 196.0;
const DEMO_LENGTH = 30;
const DEMO_HAIRPIN_CHANCE = 0.55;
const DEMO_HAIRPIN_MIN = 150.0;
const DEMO_HAIRPIN_MAX = 240.0;

/** Seconds between the ambient shockwave rings. menu.py:93 */
const RING_PERIOD = 2.9;

/** Under-glow stamps along the wordmark's baseline. menu.py:679 */
const TITLE_STAMPS = 9;

/** Snap a 0..1 weight onto `steps` levels. menu.py:130 */
function quantise(value: number, steps: number): number {
  return Math.round(clamp(value, 0, 1) * steps) / steps;
}

interface Spec {
  readonly key: string;
  readonly label: string;
  readonly style: ButtonStyle;
}

export class MenuScene extends Scene {
  readonly root = new Container();

  private readonly save: SaveData;
  private readonly sound: Audio | null;

  private t = 0;
  private entered = 0;

  private theme: Theme = THEMES[0]!;
  private themeIndex = 0;
  private themeBlend = 0;

  private readonly bgLayer = new Container();
  private readonly backgrounds = new Map<number, Background>();

  private readonly titleLayer = new Container();
  private readonly titleGlows: Sprite[] = [];
  private readonly titleLeft = new Sprite();
  private readonly titleRight = new Sprite();
  private readonly titleBody = new Sprite();
  private readonly subtitle: Label;
  private titleKey = "";
  private titleW = 0;
  private titleH = 0;
  private titleScale = 1;

  private readonly buttons: Button[] = [];
  private readonly baseX: number[] = [];
  private readonly baseY: number[] = [];
  private readonly playCaption: Label;

  private readonly badgeLayer = new Container();
  private readonly badgeGlow: Sprite;
  private readonly badgePill = new Panel(12);
  private readonly badgeLabel: Label;
  private readonly badgeCaption: Label;

  private readonly statsPanel = new Panel();
  private readonly statLabels: Label[] = [];
  private readonly starBar = new Bar();

  private readonly footerVersion: Label;
  private readonly footerHint: Label;

  private demo: Snake | null = null;
  private readonly demoView = new SnakeRenderer();
  private demoTargetX = C.WINDOW_W * 0.5;
  private demoTargetY = C.WINDOW_H * 0.5;
  private demoTimer = 0;
  private demoHairpins = 0;
  private ringTimer = RING_PERIOD;

  private rng = makeRng(0xc0ffee);

  constructor(game: Game, save: SaveData, sound: Audio | null = null) {
    super(game);
    this.save = save;
    this.sound = sound;
    const fonts = game.fonts;

    this.subtitle = new Label(fonts, fonts.body);
    this.playCaption = new Label(fonts, fonts.small);
    this.badgeLabel = new Label(fonts, fonts.tiny);
    this.badgeCaption = new Label(fonts, fonts.tiny);
    this.footerVersion = new Label(fonts, fonts.tiny);
    this.footerHint = new Label(fonts, fonts.tiny);

    for (let i = 0; i < TITLE_STAMPS; i++) {
      const s = uiGlowSprite(86, UI_WHITE, 0);
      this.titleGlows.push(s);
      this.titleLayer.addChild(s);
    }
    // The two chromatic fringes add; the body composites normally over them.
    this.titleLeft.blendMode = "add";
    this.titleRight.blendMode = "add";
    this.titleLayer.addChild(this.titleLeft, this.titleRight, this.titleBody);

    this.badgeGlow = uiGlowSprite(60, UI_WHITE, 0);
    this.badgeLayer.addChild(this.badgeGlow, this.badgePill, this.badgeLabel);

    // Seven rows of stats copy, built once and re-pointed each frame. Rows 3
    // and 5 are the right-aligned values, which take the small face.
    for (let i = 0; i < 7; i++) {
      const style = i === 1 ? fonts.h2 : i === 3 || i === 5 ? fonts.small : fonts.tiny;
      this.statLabels.push(new Label(fonts, style));
    }

    const specs = this.specs();
    const cx = C.WINDOW_W * 0.5;
    specs.forEach((spec, i) => {
      const cy = BUTTON_TOP + i * BUTTON_PITCH;
      const btn = new Button(
        fonts,
        {
          x: cx - C.UI_BUTTON_W * 0.5,
          y: cy - C.UI_BUTTON_H * 0.5,
          w: C.UI_BUTTON_W,
          h: C.UI_BUTTON_H,
        },
        spec.label,
        {
          style: spec.style,
          data: spec.key,
          // Ghost entries drop to the body face; primary and danger keep h2.
          font: spec.style === "ghost" ? fonts.body : null,
        },
      );
      this.buttons.push(btn);
      this.baseX.push(cx);
      this.baseY.push(cy);
    });

    this.root.addChild(this.bgLayer);
    this.root.addChild(this.game.particles.root);
    this.root.addChild(this.demoView.container);
    this.root.addChild(this.titleLayer, this.subtitle);
    for (const b of this.buttons) this.root.addChild(b.root);
    this.root.addChild(this.playCaption, this.badgeLayer, this.badgeCaption);
    this.root.addChild(this.statsPanel, this.starBar);
    for (const l of this.statLabels) this.root.addChild(l);
    this.root.addChild(this.footerVersion, this.footerHint);
  }

  // -------------------------------------------------------------------
  // save-file queries
  // -------------------------------------------------------------------

  private storyIndex(): number {
    return Math.trunc(clamp(this.save.storyProgress, 0, LEVEL_COUNT - 1));
  }

  private storyInProgress(): boolean {
    if (this.save.storyComplete) return false;
    return this.save.storyProgress > 0;
  }

  private difficulty(): Difficulty {
    return getDifficulty(this.game.difficulty);
  }

  private specs(): Spec[] {
    return [
      { key: "play", label: this.storyInProgress() ? "CONTINUE" : "PLAY", style: "primary" },
      { key: "levels", label: "LEVELS", style: "primary" },
      { key: "help", label: "HOW TO PLAY", style: "ghost" },
      { key: "settings", label: "SETTINGS", style: "ghost" },
      { key: "quit", label: "QUIT", style: "danger" },
    ];
  }

  // -------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------

  override onEnter(_args?: SceneEnterArgs): void {
    // Full reset - scene instances are cached and reused by the shell.
    this.t = 0;
    this.entered = 0;
    this.themeIndex = 0;
    this.themeBlend = 0;
    this.theme = THEMES[0]!;
    this.titleKey = "";
    this.ringTimer = RING_PERIOD;
    this.rng = makeRng(0xc0ffee);

    this.dropBackgrounds();
    this.spawnDemo();
    // PLAY becomes CONTINUE once a story run is part-way through.
    this.buttons[0]?.setLabel(this.storyInProgress() ? "CONTINUE" : "PLAY");

    // Particles are the shell's but must draw inside this scene.
    this.root.addChildAt(this.game.particles.root, 1);
  }

  override onExit(): void {
    // Backgrounds hold pre-rendered full-screen layers; drop them so the menu
    // does not keep a dozen alive while the game is running.
    this.dropBackgrounds();
    if (this.game.particles.root.parent === this.root) {
      this.root.removeChild(this.game.particles.root);
    }
    this.game.particles.clear();
  }

  override onResize(): void {
    // Backgrounds are built to the overscan rect, so a new viewport rebuilds.
    this.dropBackgrounds();
  }

  private dropBackgrounds(): void {
    for (const bg of this.backgrounds.values()) {
      this.bgLayer.removeChild(bg.root);
      bg.destroy();
    }
    this.backgrounds.clear();
  }

  /** Lazily build (and cache) the full-window background for a theme. */
  private background(index: number): Background | null {
    const i = ((index % THEMES.length) + THEMES.length) % THEMES.length;
    const hit = this.backgrounds.get(i);
    if (hit) return hit;
    const renderer = this.game.app?.renderer;
    if (!renderer) return null;
    const theme = THEMES[i]!;
    try {
      const bg = makeBackground(
        theme.bgStyle,
        theme,
        { ...this.game.viewport.overscan },
        renderer,
      );
      this.backgrounds.set(i, bg);
      this.bgLayer.addChild(bg.root);
      return bg;
    } catch (err) {
      console.warn("[menu] background unavailable", err);
      return null;
    }
  }

  // -------------------------------------------------------------------
  // actions
  // -------------------------------------------------------------------

  private activate(action: string): void {
    this.sound?.play("click");
    switch (action) {
      case "play":
        // The mode picker owns story-vs-free and the difficulty; the menu
        // deliberately starts nothing itself.
        this.go(SCENES.MODE);
        break;
      case "levels":
        // Level select is free play by definition.
        this.game.mode = C.MODE_FREE;
        this.go(SCENES.LEVELS);
        break;
      case "help":
        this.go(SCENES.HELP);
        break;
      case "settings":
        this.go(SCENES.SETTINGS, { back: SCENES.MENU });
        break;
      case "quit":
        // A browser tab cannot close itself, so the nearest honest thing is to
        // flush the save. The button stays for parity with the desktop wrapper,
        // where Electron can genuinely quit.
        this.save.save();
        break;
      default:
        break;
    }
  }

  private go(key: string, args?: SceneEnterArgs): void {
    if (!this.game.registeredScenes().includes(key)) return;
    this.game.switchScene(key, args);
  }

  // -------------------------------------------------------------------
  // frame
  // -------------------------------------------------------------------

  override update(dt: number): void {
    const d = clamp(dt, 0, C.MAX_DT);
    this.t += d;
    this.entered += d;

    let fired: string | null = null;
    for (const ev of this.game.uiEvents) {
      for (const b of this.buttons) {
        if (b.handlePointer(ev) && fired === null) fired = String(b.data);
      }
    }
    for (const ev of this.game.keyEvents) {
      if (ev.type !== "down" || ev.repeat) continue;
      if (ev.key === "Enter" || ev.key === " " || ev.key === "p") fired ??= "play";
      else if (ev.key === "l") fired ??= "levels";
      else if (ev.key === "h" || ev.key === "F1") fired ??= "help";
      else if (ev.key === "s" || ev.key === "o") fired ??= "settings";
      else if (ev.key === "Escape") fired ??= "quit";
    }

    this.updateTheme(d);
    this.updateDemo(d);
    this.updateButtons(d);
    this.updateAmbience(d);
    this.draw();

    if (fired !== null) this.activate(fired);
  }

  /** Advance the slow theme carousel and keep the backgrounds alive. */
  private updateTheme(dt: number): void {
    const n = THEMES.length;
    const cycles = this.t / THEME_PERIOD;
    const index = Math.trunc(cycles) % n;
    const frac = cycles - Math.floor(cycles);

    const fadeStart = 1 - THEME_FADE / THEME_PERIOD;
    const raw = frac < fadeStart ? 0 : (frac - fadeStart) / Math.max(1e-6, 1 - fadeStart);

    this.themeIndex = index;
    this.themeBlend = quantise(raw, THEME_BLEND_STEPS);
    this.theme = blendThemes(THEMES[index]!, THEMES[(index + 1) % n]!, this.themeBlend);

    const focus = { x: this.demo?.x ?? C.WINDOW_W * 0.5, y: this.demo?.y ?? C.WINDOW_H * 0.5 };
    const current = this.background(index);
    current?.update(dt, focus);
    if (raw > 0) this.background((index + 1) % n)?.update(dt, focus);

    // Only the current pair, and the one just retired, is worth keeping.
    if (this.backgrounds.size > 3) {
      const keep = new Set([index, (index + 1) % n, (index - 1 + n) % n]);
      for (const key of [...this.backgrounds.keys()]) {
        if (keep.has(key)) continue;
        const bg = this.backgrounds.get(key);
        if (bg) {
          this.bgLayer.removeChild(bg.root);
          bg.destroy();
        }
        this.backgrounds.delete(key);
      }
    }
  }

  /** Drifting motes plus a slow shockwave that keeps the backdrop alive. */
  private updateAmbience(dt: number): void {
    const mid = lerpColor(this.theme.accent, this.theme.accent2, 0.5);
    this.game.particles.ambient(
      { x: 0, y: 0, w: C.WINDOW_W, h: C.WINDOW_H },
      mid,
      dt,
      { rate: 9.0, turbulence: 0.12, twinkle: 0.3 },
    );

    this.ringTimer -= dt;
    if (this.ringTimer <= 0) {
      this.ringTimer = RING_PERIOD * (0.8 + this.rng() * 0.5);
      // Rings sit off the button column so they read as weather, not as UI.
      const side = this.rng() < 0.5 ? -1 : 1;
      const x = C.WINDOW_W * 0.5 + side * (300 + this.rng() * 220);
      const y = 180 + this.rng() * (C.WINDOW_H - 300);
      this.game.particles.ring(x, y, this.theme.accent2, {
        radius: 40 + this.rng() * 50,
        count: 14,
        life: 1.1,
        speed: 70,
        colorEnd: this.theme.accent,
      });
    }
  }

  // -------------------------------------------------------------------
  // demo snake
  // -------------------------------------------------------------------

  private spawnDemo(): void {
    const heading = this.rng() * Math.PI * 2;
    this.demo = new Snake(C.WINDOW_W * 0.5, C.WINDOW_H * 0.62, heading, DEMO_LENGTH);
    this.demo.speed = DEMO_SPEED;
    this.pickTarget();
    this.demoTimer = 0;
    this.demoHairpins = 0;
  }

  /** A random wander point, biased away from the button column. */
  private pickTarget(): void {
    for (let i = 0; i < 6; i++) {
      const x = DEMO_MARGIN + this.rng() * (C.WINDOW_W - DEMO_MARGIN * 2);
      const y = DEMO_MARGIN + 60 + this.rng() * (C.WINDOW_H - DEMO_MARGIN * 2 - 60);
      // Keep it out of the middle column where the buttons live, so it weaves
      // around the UI instead of hiding behind it.
      if (Math.abs(x - C.WINDOW_W * 0.5) > 240 || y < 300) {
        this.demoTargetX = x;
        this.demoTargetY = y;
        return;
      }
    }
    this.demoTargetX = C.WINDOW_W * 0.5;
    this.demoTargetY = C.WINDOW_H * 0.5;
  }

  /**
   * A point *behind* the head, so the demo has to turn all the way round.
   *
   * Turning is constant-radius, so this always resolves into a tight, readable
   * loop that passes right over the snake's own neck - the best advertisement
   * the movement model has.
   */
  private hairpinTarget(): void {
    const snake = this.demo;
    if (!snake) return this.pickTarget();
    const head = snake.headPos();
    const ang = snake.heading + Math.PI + (this.rng() - 0.5) * 1.1;
    const reach = DEMO_HAIRPIN_MIN + this.rng() * (DEMO_HAIRPIN_MAX - DEMO_HAIRPIN_MIN);
    this.demoTargetX = clamp(head.x + Math.cos(ang) * reach, DEMO_MARGIN, C.WINDOW_W - DEMO_MARGIN);
    this.demoTargetY = clamp(
      head.y + Math.sin(ang) * reach,
      DEMO_MARGIN + 60,
      C.WINDOW_H - DEMO_MARGIN,
    );
  }

  private nextDemoLeg(): void {
    if (this.demoHairpins > 0) {
      this.demoHairpins -= 1;
      this.hairpinTarget();
      this.demoTimer = 1.3 + this.rng() * 0.8;
      return;
    }
    this.pickTarget();
    this.demoTimer = 2.2 + this.rng() * 1.8;
    if (this.rng() < DEMO_HAIRPIN_CHANCE) {
      this.demoHairpins = this.rng() < 0.5 ? 1 : 2;
    }
  }

  private updateDemo(dt: number): void {
    const snake = this.demo;
    if (!snake) return;

    this.demoTimer -= dt;
    let head = snake.headPos();

    // Outside the safe inset the target is overridden with the screen centre,
    // which is always reachable at this turn rate.
    const inside =
      head.x >= DEMO_MARGIN &&
      head.x <= C.WINDOW_W - DEMO_MARGIN &&
      head.y >= DEMO_MARGIN &&
      head.y <= C.WINDOW_H - DEMO_MARGIN;
    if (!inside) {
      this.demoTargetX = C.WINDOW_W * 0.5;
      this.demoTargetY = C.WINDOW_H * 0.5;
      this.demoTimer = Math.max(this.demoTimer, 1.2);
      this.demoHairpins = 0;
    } else if (
      this.demoTimer <= 0 ||
      dist(head.x, head.y, this.demoTargetX, this.demoTargetY) < 70
    ) {
      this.nextDemoLeg();
    }

    snake.setTarget(this.demoTargetX, this.demoTargetY);
    snake.update(dt);

    // A hard bail-out in case anything ever pushes it off screen entirely.
    head = snake.headPos();
    if (
      head.x < -200 ||
      head.x > C.WINDOW_W + 200 ||
      head.y < -200 ||
      head.y > C.WINDOW_H + 200
    ) {
      this.spawnDemo();
      return;
    }

    this.game.particles.trail(head.x, head.y, this.theme.snakeA, dt, {
      rate: 22,
      speed: [6, 30],
      life: [0.3, 0.75],
      radius: [1.6, 3.6],
      ribbon: 0.3,
      colorEnd: this.theme.snakeB,
    });

    // Hard steering throws sparks off the outside of the turn, so a hairpin
    // looks like it costs something.
    const turn = snake.turnInput;
    if (Math.abs(turn) > 0.65) {
      const side = snake.heading + (turn < 0 ? Math.PI * 0.5 : -Math.PI * 0.5);
      this.game.particles.stream(head.x, head.y, side, this.theme.accent2, dt, {
        rate: 26,
        speed: [50, 130],
        spread: 0.5,
        life: [0.18, 0.4],
        radius: [1.4, 3.0],
      });
    }
  }

  // -------------------------------------------------------------------
  // buttons
  // -------------------------------------------------------------------

  private updateButtons(dt: number): void {
    for (let i = 0; i < this.buttons.length; i++) {
      const b = this.buttons[i]!;
      const local = this.entered - i * BUTTON_STAGGER;
      let cx = this.baseX[i]!;
      if (local < BUTTON_ENTRANCE) {
        const k = easeOutBack(clamp(local / BUTTON_ENTRANCE, 0, 1));
        // Alternate the side each button flies in from.
        const side = i % 2 === 0 ? -1 : 1;
        cx += side * BUTTON_SLIDE * (1 - k);
      }
      b.rect.x = cx - C.UI_BUTTON_W * 0.5;
      b.rect.y = this.baseY[i]! - C.UI_BUTTON_H * 0.5;

      const was = b.hovered;
      b.update(dt, this.game.pointer);
      if (b.hovered && !was) this.sound?.play("hover");
    }
  }

  private buttonAlpha(index: number): number {
    const local = this.entered - index * BUTTON_STAGGER;
    return clamp(local / (BUTTON_ENTRANCE * 0.6), 0, 1);
  }

  // -------------------------------------------------------------------
  // draw
  // -------------------------------------------------------------------

  private draw(): void {
    this.drawBackground();
    this.drawDemo();
    this.drawTitle();
    this.drawButtons();
    this.drawBadge();
    this.drawStats();
    this.drawFooter();
  }

  private drawBackground(): void {
    const n = THEMES.length;
    for (const [i, bg] of this.backgrounds) {
      const isCurrent = i === this.themeIndex;
      const isNext = i === (this.themeIndex + 1) % n;
      bg.root.visible = isCurrent || (isNext && this.themeBlend > 0.001);
      // The incoming stage simply fades in over the outgoing one; Pixi needs no
      // scratch layer for what the Python had to composite by hand.
      bg.root.alpha = isCurrent ? 1 : clamp(this.themeBlend, 0, 1);
      bg.root.zIndex = isCurrent ? 0 : 1;
    }
    this.bgLayer.sortableChildren = true;
  }

  private drawDemo(): void {
    const snake = this.demo;
    this.demoView.container.visible = snake !== null;
    if (snake) this.demoView.draw(snake, this.theme, this.t, {});
  }

  private drawTitle(): void {
    const fonts = this.game.fonts;
    const theme = this.theme;

    // Rebuild the wordmark art only when the quantised theme moves on.
    const key = `${this.themeIndex}|${this.themeBlend}`;
    if (key !== this.titleKey) {
      this.titleKey = key;
      const tex = glyphTexture(C.GAME_TITLE, fonts.huge, fonts);
      // Shrink to fit if the chosen display face renders wide.
      this.titleScale = tex.width > TITLE_MAX_W ? TITLE_MAX_W / tex.width : 1;
      this.titleW = tex.width * this.titleScale;
      this.titleH = tex.height * this.titleScale;
      for (const s of [this.titleBody, this.titleLeft, this.titleRight]) {
        s.texture = tex;
        s.scale.set(this.titleScale);
      }
      this.titleBody.tint = toHex(lerpColor(theme.text, UI_WHITE, 0.55));
      this.titleLeft.tint = toHex(shade(theme.accent, 0.85));
      this.titleRight.tint = toHex(shade(theme.accent2, 0.85));
    }

    const cx = C.WINDOW_W * 0.5;
    // Entrance: the wordmark drops in and settles before the buttons start.
    const k = easeOutBack(clamp(this.entered / 0.62, 0, 1));
    const top = 116 - (1 - k) * 60;

    const breathe = pulse(this.t, 0.9);
    // A row of additive stamps along the baseline reads as one soft bar of
    // light behind the letters, for a handful of sprites.
    const glowY = top + this.titleH * 0.52;
    for (let i = 0; i < TITLE_STAMPS; i++) {
      const f = i / (TITLE_STAMPS - 1);
      const gx = cx + (f - 0.5) * this.titleW * 0.92;
      const s = this.titleGlows[i]!;
      s.position.set(gx, glowY);
      setUiGlow(s, 86, lerpColor(theme.accent, theme.accent2, f), 0.3 + 0.16 * breathe);
    }

    // Chromatic split, breathing between roughly 1.5 and 5 px.
    const split = 1.5 + 3.5 * pulse(this.t * 0.85, 1.0);
    const wob = Math.sin(this.t * 1.7) * 1.4;
    const x = cx - this.titleW * 0.5;
    this.titleLeft.position.set(x - split, top + wob);
    this.titleRight.position.set(x + split, top - wob);
    this.titleBody.position.set(x, top);

    this.subtitle.set(`${C.GAME_SUBTITLE.toUpperCase()}   -   ${theme.name.toUpperCase()}`);
    this.subtitle.setColor(lerpColor(theme.textDim, theme.accent, 0.35 + 0.25 * breathe));
    this.subtitle.place(cx, top + this.titleH + 6, "center");
  }

  /** The line above PLAY, telling the player exactly what it will do. */
  private playCaptionText(): string {
    if (this.storyInProgress()) {
      const idx = this.storyIndex();
      const beat = getBeat(idx);
      const chapter = getChapter(idx);
      return `STORY  -  CHAPTER ${chapter.roman()}  -  ${String(beat.number).padStart(2, "0")} ${beat.title.toUpperCase()}`;
    }
    if (this.save.storyComplete) return "STORY COMPLETE  -  REPLAY OR PICK A LEVEL";
    return "CHOOSE STORY OR FREE PLAY";
  }

  private drawButtons(): void {
    for (let i = 0; i < this.buttons.length; i++) {
      const b = this.buttons[i]!;
      const a = this.buttonAlpha(i);
      b.root.visible = a > 0;
      if (a > 0) b.draw(this.theme, this.t);
    }

    const show = this.entered > 0.5;
    this.playCaption.visible = show;
    if (show) {
      this.playCaption.set(this.playCaptionText());
      this.playCaption.setColor(this.theme.textDim);
      this.playCaption.place(
        C.WINDOW_W * 0.5,
        this.baseY[0]! - C.UI_BUTTON_H * 0.5 - 30,
        "center",
      );
    }
  }

  /**
   * The coloured pill beside PLAY naming the difficulty of the next run.
   *
   * It sits outside the button so it never fights the button's own hover
   * animation, and fades in with the stack.
   */
  private drawBadge(): void {
    const show = this.entered >= 0.35;
    this.badgeLayer.visible = show;
    this.badgeCaption.visible = show;
    if (!show) return;

    const diff = this.difficulty();
    const fonts = this.game.fonts;
    this.badgeLabel.set(diff.hudLabel);
    this.badgeLabel.setColor(lerpColor(diff.color, UI_WHITE, 0.35));
    this.badgeLabel.setShadow(false);

    const textW = fonts.measureWidth(fonts.tiny, diff.hudLabel);
    const w = textW + 30;
    const h = Math.max(24, this.badgeLabel.textHeight + 12);

    const k = easeOutBack(clamp((this.entered - 0.35) / 0.45, 0, 1));
    const right = C.WINDOW_W * 0.5 + C.UI_BUTTON_W * 0.5;
    const cy = this.baseY[0]!;
    const x = right + 16 + (1 - k) * 40;
    const y = cy - h * 0.5;

    // A soft halo in the mode's own colour, so EXPERT reads red at a glance.
    this.badgeGlow.position.set(x + w * 0.5, cy);
    setUiGlow(
      this.badgeGlow,
      w * 0.75,
      diff.color,
      (0.22 + 0.12 * pulse(this.t, 1.1)) * k,
    );

    this.badgePill.setRect(x, y, w, h);
    this.badgePill.setStyle(diff.color, 232, true, 0);
    this.badgeLayer.alpha = clamp(k, 0, 1);
    this.badgeLabel.place(x + w * 0.5, y + (h - this.badgeLabel.textHeight) * 0.5, "center");

    this.badgeCaption.set("DIFFICULTY");
    this.badgeCaption.setColor(shade(this.theme.textDim, 0.85));
    this.badgeCaption.place(x, cy - h * 0.5 - 17);
  }

  /** Best score, story chapter, campaign progress and stars, bottom-left. */
  private drawStats(): void {
    const theme = this.theme;
    // Slide the panel in from the left, just behind the buttons.
    const k = easeOutBack(clamp((this.entered - 0.18) / 0.6, 0, 1));
    const px = 34 - (1 - k) * 260;
    const py = C.WINDOW_H - 204;
    const pw = 286;

    this.statsPanel.setRect(px, py, pw, 170);
    this.statsPanel.setStyle(theme.accent, 206, true, 0.25 + 0.12 * pulse(this.t, 1.3));

    const best = this.save.highscore;
    const stars = this.save.totalStars();
    const maxStars = Math.max(1, this.save.maxStars());
    const [cleared, total] = this.save.progress();

    const rows: Array<[string, number, number, "left" | "right", readonly [number, number, number]]> =
      [
        ["BEST SCORE", px + 18, py + 12, "left", theme.textDim],
        [best.toLocaleString("en-US"), px + 18, py + 30, "left", lerpColor(UI_GOLD, UI_WHITE, 0.25)],
        ["STORY", px + 18, py + 72, "left", theme.textDim],
        [this.storySummary(), px + pw - 18, py + 70, "right", lerpColor(theme.text, theme.accent, 0.35)],
        ["STARS", px + 18, py + 98, "left", theme.textDim],
        [`${stars} / ${maxStars}`, px + pw - 18, py + 96, "right", UI_GOLD],
        [`LEVELS CLEARED  ${cleared} / ${total}`, px + 18, py + 140, "left", shade(theme.textDim, 0.95)],
      ];
    rows.forEach(([text, x, y, align, col], i) => {
      const l = this.statLabels[i]!;
      l.set(text);
      l.setColor(col);
      l.place(x, y, align);
    });

    // The star count shares row 4's y but is right-aligned; drawn by reusing
    // the STARS label's slot would collide, so it rides the bar's label.
    this.starBar.setRect(px + 18, py + 122, pw - 36, 9);
    this.starBar.set(stars / maxStars, UI_GOLD, performance.now());
  }

  /** `CHAPTER II OF IV` - or the end-states either side of it. */
  private storySummary(): string {
    if (this.save.storyComplete) return "COMPLETE";
    if (!this.storyInProgress()) return "NOT STARTED";
    const chapter = getChapter(this.storyIndex());
    const last = CHAPTERS[CHAPTERS.length - 1] ?? chapter;
    return `CHAPTER ${chapter.roman()} OF ${last.roman()}`;
  }

  private drawFooter(): void {
    const theme = this.theme;
    this.footerVersion.set(`v${C.VERSION}`);
    this.footerVersion.setColor(shade(theme.textDim, 0.7));
    this.footerVersion.place(C.WINDOW_W - 20, C.WINDOW_H - 26, "right");

    this.footerHint.set("MOUSE STEERS  -  RIGHT-CLICK BOOSTS  -  ENTER PLAYS");
    this.footerHint.setColor(shade(theme.textDim, 0.8));
    this.footerHint.place(C.WINDOW_W * 0.5, C.WINDOW_H - 26, "center");
  }
}
