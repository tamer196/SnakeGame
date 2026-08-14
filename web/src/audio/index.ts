/**
 * Barrel for the sound engine.
 *
 * The game should only ever need {@link Audio} and {@link installUnlockGesture};
 * the DSP layer is exported alongside because the parity spec drives it
 * directly, and because a tool that wants to dump a cue to a WAV file should
 * not have to reach into the module's internals to do it.
 */

export {
  Audio,
  installUnlockGesture,
  minInterval,
  soundGain,
  voiceGain,
  type AudioBufferLike,
  type AudioBufferSourceLike,
  type AudioContextLike,
  type AudioNodeLike,
  type AudioOptions,
  type AudioParamLike,
  type GainNodeLike,
  type GestureTarget,
} from "./Audio";

export {
  SOUND_NAMES,
  buildSig,
  isSoundName,
  renderSound,
  type Recipe,
  type SoundName,
  type StereoPcm,
} from "./recipes";

export {
  MersenneTwister,
  SINE,
  Sig,
  semitone,
  type EnvParams,
  type NoiseOptions,
  type Shape,
  type ToneOptions,
} from "./dsp";
