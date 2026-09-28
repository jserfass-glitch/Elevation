// A range slider with two handles, built from two overlapping native range
// inputs so keyboard and screen-reader support come for free. Only the thumbs
// take pointer input; the track is painted by the caller.

export class DualRange {
  /**
   * @param {HTMLElement} root  element containing two <input type="range">
   * @param {(lo: number, hi: number, moved: 'lo'|'hi') => void} onInput
   */
  constructor(root, onInput) {
    this.root = root;
    [this.lo, this.hi] = root.querySelectorAll('input[type=range]');
    for (const [input, which] of [[this.lo, 'lo'], [this.hi, 'hi']]) {
      input.addEventListener('input', () => {
        // Keep the handles from crossing.
        if (Number(this.lo.value) > Number(this.hi.value)) {
          if (which === 'lo') this.lo.value = this.hi.value;
          else this.hi.value = this.lo.value;
        }
        this.#stack();
        onInput(Number(this.lo.value), Number(this.hi.value), which);
      });
    }
    // Whichever thumb is nearer the pointer goes on top, so two thumbs that
    // sit together can still be pulled apart in either direction.
    root.addEventListener('pointerdown', (e) => {
      const box = root.getBoundingClientRect();
      const frac = (e.clientX - box.left) / box.width;
      const val = Number(this.lo.min) + frac * (Number(this.lo.max) - Number(this.lo.min));
      const nearLo = Math.abs(val - Number(this.lo.value)) <= Math.abs(val - Number(this.hi.value));
      this.lo.style.zIndex = nearLo ? 2 : 1;
      this.hi.style.zIndex = nearLo ? 1 : 2;
    }, { capture: true });
  }

  setRange(min, max, step = 1) {
    for (const input of [this.lo, this.hi]) {
      input.min = min;
      input.max = max;
      input.step = step;
      input.disabled = false;
    }
  }

  setValues(lo, hi) {
    this.lo.value = lo;
    this.hi.value = hi;
    this.#stack();
  }

  get values() {
    return [Number(this.lo.value), Number(this.hi.value)];
  }

  /** Handle positions as percentages of the track. */
  get percents() {
    const min = Number(this.lo.min);
    const span = Number(this.lo.max) - min || 1;
    return this.values.map((v) => ((v - min) / span) * 100);
  }

  /** Paints the track with a CSS background. */
  paint(background) {
    this.root.style.setProperty('--track', background);
  }

  // When both handles sit at the top end, the low one must be on top or it
  // could never be dragged back down.
  #stack() {
    const atTop = Number(this.lo.value) >= Number(this.lo.max) - Number(this.lo.step || 1);
    this.lo.style.zIndex = atTop ? 2 : 1;
    this.hi.style.zIndex = atTop ? 1 : 2;
  }
}
