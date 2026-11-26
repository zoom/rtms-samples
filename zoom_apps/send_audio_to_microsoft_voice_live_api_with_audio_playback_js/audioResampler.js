const BYTES_PER_SAMPLE = 2;

/**
 * Build a normalized Blackman-windowed sinc low-pass FIR kernel.
 * @param {number} numTaps - Odd number of FIR filter taps (e.g. 23)
 * @param {number} normalizedCutoff - Cutoff as a fraction of input sample rate (0 < fc < 0.5)
 */
export function designLowPassFirKernel(numTaps = 23, normalizedCutoff = 0.22) {
  const kernel = new Float64Array(numTaps);
  const center = (numTaps - 1) / 2;
  let sum = 0;

  for (let i = 0; i < numTaps; i += 1) {
    const n = i - center;
    const sinc = n === 0
      ? 2 * normalizedCutoff
      : Math.sin(2 * Math.PI * normalizedCutoff * n) / (Math.PI * n);
    // Blackman window (>60 dB stopband attenuation)
    const window =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * i) / (numTaps - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (numTaps - 1));
    kernel[i] = sinc * window;
    sum += kernel[i];
  }

  for (let i = 0; i < numTaps; i += 1) {
    kernel[i] /= sum;
  }

  return kernel;
}

// 23-tap half-band low-pass FIR filter for 48 kHz -> 24 kHz (2:1 decimation)
// Cutoff ~10.56 kHz (0.22 * 48 kHz), >60 dB attenuation above 14 kHz (eliminates aliasing).
const HALF_BAND_TAPS = 23;
export const HALF_BAND_KERNEL = designLowPassFirKernel(HALF_BAND_TAPS, 0.22);

export function createResamplerState() {
  return {
    history: new Float64Array(HALF_BAND_TAPS - 1),
    leftoverSample: null,
  };
}

function clampPcm16(value) {
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return value;
}

/**
 * Resample mono 16-bit little-endian PCM from `sourceRate` to `targetRate`.
 * Uses a low-pass FIR half-band decimation filter for 2:1 downsampling (e.g. 48k -> 24k),
 * and windowed-sinc low-pass filtering for other downsampling ratios.
 *
 * Pass a persistent `state = createResamplerState()` per session for seamless chunk boundaries.
 */
export function resamplePcm16Mono(inputBuffer, sourceRate, targetRate, state = null) {
  if (!inputBuffer || inputBuffer.length < BYTES_PER_SAMPLE) {
    return Buffer.alloc(0);
  }

  if (sourceRate === targetRate) {
    return Buffer.from(inputBuffer);
  }

  const inputSamples = Math.floor(inputBuffer.length / BYTES_PER_SAMPLE);
  if (inputSamples === 0) {
    return Buffer.alloc(0);
  }

  // Exact 2:1 decimation path (e.g. 48 kHz -> 24 kHz) using low-pass FIR half-band filter
  if (sourceRate === targetRate * 2) {
    const historyLen = HALF_BAND_TAPS - 1;
    const prev = state?.history instanceof Float64Array && state.history.length === historyLen
      ? state.history
      : new Float64Array(historyLen);

    const hasLeftover = state && state.leftoverSample !== null;
    const totalNewSamples = inputSamples + (hasLeftover ? 1 : 0);
    const usableSamples = totalNewSamples - (totalNewSamples % 2);
    const outputSamples = usableSamples / 2;

    if (outputSamples === 0) {
      if (state && inputSamples === 1) {
        state.leftoverSample = inputBuffer.readInt16LE(0);
      }
      return Buffer.alloc(0);
    }

    const work = new Float64Array(historyLen + totalNewSamples);
    work.set(prev, 0);
    let writeOffset = historyLen;
    if (hasLeftover) {
      work[writeOffset++] = state.leftoverSample;
      state.leftoverSample = null;
    }
    for (let i = 0; i < inputSamples; i += 1) {
      work[writeOffset++] = inputBuffer.readInt16LE(i * BYTES_PER_SAMPLE);
    }

    const outputBuffer = Buffer.allocUnsafe(outputSamples * BYTES_PER_SAMPLE);

    for (let outIdx = 0; outIdx < outputSamples; outIdx += 1) {
      // Decimate by 2 after FIR low-pass filtering
      const endPos = historyLen + (outIdx * 2) + 1;
      let acc = 0;
      for (let t = 0; t < HALF_BAND_TAPS; t += 1) {
        acc += HALF_BAND_KERNEL[t] * work[endPos - t];
      }
      outputBuffer.writeInt16LE(clampPcm16(Math.round(acc)), outIdx * BYTES_PER_SAMPLE);
    }

    if (state) {
      // Save last (HALF_BAND_TAPS - 1) consumed samples as filter state for next chunk
      state.history.set(work.subarray(usableSamples, usableSamples + historyLen));
      if (totalNewSamples > usableSamples) {
        state.leftoverSample = work[historyLen + totalNewSamples - 1];
      }
    }

    return outputBuffer;
  }

  // General low-pass windowed-sinc resampler for other ratios (e.g. 32k->24k, 16k->24k, 8k->24k)
  const samples = new Float64Array(inputSamples);
  for (let i = 0; i < inputSamples; i += 1) {
    samples[i] = inputBuffer.readInt16LE(i * BYTES_PER_SAMPLE);
  }

  // Apply anti-aliasing FIR low-pass filter before downsampling
  let filtered = samples;
  if (sourceRate > targetRate) {
    const cutoff = 0.45 * (targetRate / sourceRate);
    const kernel = designLowPassFirKernel(23, cutoff);
    const half = (kernel.length - 1) / 2;
    filtered = new Float64Array(inputSamples);
    for (let i = 0; i < inputSamples; i += 1) {
      let acc = 0;
      for (let t = 0; t < kernel.length; t += 1) {
        const idx = Math.max(0, Math.min(inputSamples - 1, i + t - half));
        acc += kernel[t] * samples[idx];
      }
      filtered[i] = acc;
    }
  }

  const outputSamples = Math.max(1, Math.round((inputSamples * targetRate) / sourceRate));
  const outputBuffer = Buffer.allocUnsafe(outputSamples * BYTES_PER_SAMPLE);
  const ratio = sourceRate / targetRate;

  for (let outIdx = 0; outIdx < outputSamples; outIdx += 1) {
    const pos = outIdx * ratio;
    const idx = Math.floor(pos);
    const nextIdx = Math.min(idx + 1, inputSamples - 1);
    const frac = pos - idx;
    const value = filtered[idx] + (filtered[nextIdx] - filtered[idx]) * frac;
    outputBuffer.writeInt16LE(clampPcm16(Math.round(value)), outIdx * BYTES_PER_SAMPLE);
  }

  return outputBuffer;
}
