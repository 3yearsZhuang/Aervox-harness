interface Entry<T> {
  value: T;
  score: number;
  order: number;
}

function worse<T>(a: Entry<T>, b: Entry<T>): boolean {
  return a.score < b.score || (a.score === b.score && a.order > b.order);
}

/** Retains the highest scores in O(N log K), preserving encounter order on ties. */
export class TopK<T> {
  private readonly heap: Entry<T>[] = [];
  private order = 0;

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("topK must be a nonnegative safe integer");
  }

  add(value: T, score: number): void {
    if (this.limit === 0 || Number.isNaN(score)) return;
    const entry = { value, score, order: this.order++ };
    if (this.heap.length < this.limit) {
      this.heap.push(entry);
      let index = this.heap.length - 1;
      while (index > 0) {
        const parent = (index - 1) >>> 1;
        if (!worse(this.heap[index]!, this.heap[parent]!)) break;
        [this.heap[index], this.heap[parent]] = [this.heap[parent]!, this.heap[index]!];
        index = parent;
      }
      return;
    }
    if (!worse(this.heap[0]!, entry)) return;
    this.heap[0] = entry;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      if (left >= this.heap.length) break;
      const right = left + 1;
      const child = right < this.heap.length && worse(this.heap[right]!, this.heap[left]!) ? right : left;
      if (!worse(this.heap[child]!, this.heap[index]!)) break;
      [this.heap[index], this.heap[child]] = [this.heap[child]!, this.heap[index]!];
      index = child;
    }
  }

  values(): T[] {
    return [...this.heap].sort((a, b) => b.score - a.score || a.order - b.order).map((entry) => entry.value);
  }
}
