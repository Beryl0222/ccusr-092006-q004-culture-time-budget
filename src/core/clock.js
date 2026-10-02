// 时钟抽象：生产用 SystemClock，测试用 FixedClock，保证时间相关逻辑可复现。

export class SystemClock {
  now() {
    return new Date();
  }
}

export class FixedClock {
  constructor(iso) {
    this.ms = new Date(iso).getTime();
    if (Number.isNaN(this.ms)) throw new Error(`FixedClock: 无法解析时间 ${iso}`);
  }
  now() {
    return new Date(this.ms);
  }
  set(iso) {
    this.ms = new Date(iso).getTime();
  }
  advance(deltaMs) {
    this.ms += deltaMs;
  }
  advanceMinutes(n) {
    this.ms += n * 60_000;
  }
}
