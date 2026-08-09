declare module "butterchurn" {
  export interface BCAudioLevels {
    timeByteArray: Uint8Array;
    timeByteArrayL: Uint8Array;
    timeByteArrayR: Uint8Array;
  }

  export interface BCVisualizer {
    loadPreset(preset: unknown, blendTime?: number): void;
    setRendererSize(width: number, height: number): void;
    render(opts?: { audioLevels?: BCAudioLevels; elapsedTime?: number }): unknown;
    connectAudio(node: AudioNode): void;
    disconnectAudio(node: AudioNode): void;
    loseGLContext(): void;
  }

  const butterchurn: {
    createVisualizer(
      audioContext: AudioContext,
      canvas: HTMLCanvasElement,
      opts: {
        width: number;
        height: number;
        pixelRatio?: number;
        textureRatio?: number;
        meshWidth?: number;
        meshHeight?: number;
      },
    ): BCVisualizer;
  };
  export default butterchurn;
}

declare module "butterchurn-presets" {
  const presets: Record<string, unknown>;
  export default presets;
}

declare module "butterchurn-presets/presetPackMeta.js" {
  export function getBasePresetKeys(): {
    presets: string[];
    chunk: string;
  };
}
