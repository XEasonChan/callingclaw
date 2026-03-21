// CallingClaw 2.0 — Desktop Capture Provider
// Uses macOS screencapture CLI + sips for full-screen desktop screenshots.
// Primary use: Computer Use module (needs to see desktop apps, not just browser).
//
// Each capture uses a unique file path to avoid race conditions.
// Gray image detection catches Screen Recording permission loss.

import type { CaptureProvider, CaptureResult } from "../types/screen";

const TMP_DIR = "/tmp/callingclaw_captures";
const DEFAULT_TARGET_WIDTH = 1280;
const DEFAULT_TARGET_HEIGHT = 800;

// Gray image detection: if std deviation of sampled pixel values is below
// this threshold, the image is likely a permission-denied gray screenshot.
const GRAY_STD_DEV_THRESHOLD = 5;
const GRAY_SAMPLE_COUNT = 200;

export class DesktopCaptureProvider implements CaptureProvider {
  readonly source = "desktop" as const;
  private _tmpDirCreated = false;

  async capture(options?: {
    targetWidth?: number;
    targetHeight?: number;
    displayIndex?: number;
  }): Promise<CaptureResult | null> {
    const targetW = options?.targetWidth ?? DEFAULT_TARGET_WIDTH;
    const targetH = options?.targetHeight ?? DEFAULT_TARGET_HEIGHT;
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const capturePath = `${TMP_DIR}/cc_${id}.jpg`;
    const resizedPath = `${TMP_DIR}/cc_${id}_r.jpg`;

    try {
      // Ensure tmp dir exists
      if (!this._tmpDirCreated) {
        await Bun.$`mkdir -p ${TMP_DIR}`.quiet();
        this._tmpDirCreated = true;
      }

      // 1. Capture screenshot (silent, JPEG)
      let result;
      if (options?.displayIndex) {
        result = await Bun.$`screencapture -x -t jpg -D ${String(options.displayIndex)} ${capturePath}`.quiet().nothrow();
      } else {
        result = await Bun.$`screencapture -x -t jpg ${capturePath}`.quiet().nothrow();
      }

      if (result.exitCode !== 0) {
        console.error(`[DesktopCapture] screencapture failed (exit ${result.exitCode})`);
        return null;
      }

      // 2. Read the file
      const file = Bun.file(capturePath);
      if (!await file.exists() || file.size === 0) {
        console.error("[DesktopCapture] Screenshot file empty or missing");
        return null;
      }

      // 3. Gray image detection (permission check)
      const rawBuffer = await file.arrayBuffer();
      if (this.isGrayImage(new Uint8Array(rawBuffer))) {
        console.error("[DesktopCapture] Gray image detected — Screen Recording permission may be revoked");
        return null;
      }

      // 4. Resize with sips
      await Bun.$`sips --resampleWidth ${targetW} --resampleHeight ${targetH} --setProperty formatOptions 70 ${capturePath} --out ${resizedPath}`.quiet().nothrow();

      // Read resized file (fall back to original if sips failed)
      const resizedFile = Bun.file(resizedPath);
      const finalFile = await resizedFile.exists() ? resizedFile : file;
      const buffer = Buffer.from(await finalFile.arrayBuffer());
      const base64 = buffer.toString("base64");

      return {
        image: base64,
        width: targetW,
        height: targetH,
        metadata: {
          displayIndex: options?.displayIndex ?? 1,
        },
      };
    } catch (e: any) {
      console.error(`[DesktopCapture] Error: ${e.message}`);
      return null;
    } finally {
      // Cleanup temp files
      Bun.$`rm -f ${capturePath} ${resizedPath}`.quiet().nothrow();
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Check if screencapture binary exists
      const result = await Bun.$`which screencapture`.quiet().nothrow();
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  /**
   * Detect gray/blank screenshots from permission denial.
   * Samples pixels from the JPEG file header area.
   * If standard deviation of sampled byte values is very low, it's likely gray.
   */
  private isGrayImage(data: Uint8Array): boolean {
    if (data.length < 1000) return true; // Too small to be a real screenshot

    // Sample bytes evenly across the file (skip JPEG header ~600 bytes)
    const start = Math.min(600, Math.floor(data.length * 0.1));
    const step = Math.max(1, Math.floor((data.length - start) / GRAY_SAMPLE_COUNT));
    const samples: number[] = [];

    for (let i = start; samples.length < GRAY_SAMPLE_COUNT && i < data.length; i += step) {
      samples.push(data[i]!);
    }

    if (samples.length < 50) return false;

    // Calculate standard deviation
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((sum, v) => sum + (v - mean) ** 2, 0) / samples.length;
    const stdDev = Math.sqrt(variance);

    return stdDev < GRAY_STD_DEV_THRESHOLD;
  }
}
