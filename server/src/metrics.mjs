/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 서버 지표. 카운터·게이지·히스토그램을 모아 Prometheus 텍스트 형식(/metrics)으로 내보낸다. 의존성 없는 작은 레지스트리다.
 */
/**
 *   const m = createMetrics();
 *   m.declare('skala_rooms', 'gauge', '열린 방 수');
 *   m.set('skala_rooms', null, 3);
 *   m.inc('skala_messages_in_total', { type: 'in' });
 *   m.histogram('skala_tick_duration_ms', '틱 하나의 계산 시간(ms)', [0.5, 1, 2, 5, 10, 20, 33]);
 *   m.observe('skala_tick_duration_ms', 1.7);
 *   res.end(m.render());
 */

const escapeLabel = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

function labelText(labels) {
  if (!labels) return '';
  const keys = Object.keys(labels).sort();
  if (!keys.length) return '';
  return `{${keys.map((k) => `${k}="${escapeLabel(labels[k])}"`).join(',')}}`;
}

export function createMetrics() {
  const defs = new Map();     // name → { type, help, series: Map(labelText → value) | histogram }

  function def(name) {
    const d = defs.get(name);
    if (!d) throw new Error(`metric not declared: ${name}`);
    return d;
  }

  return {
    /** 카운터·게이지를 선언한다(이름은 Prometheus 규칙: 소문자와 _) */
    declare(name, type, help) {
      if (!defs.has(name)) defs.set(name, { type, help, series: new Map() });
    },
    inc(name, labels = null, v = 1) {
      const s = def(name).series;
      const k = labelText(labels);
      s.set(k, (s.get(k) || 0) + v);
    },
    set(name, labels, v) {
      def(name).series.set(labelText(labels), v);
    },
    /** 히스토그램 선언. buckets = 위 경계(오름차순) */
    histogram(name, help, buckets) {
      if (!defs.has(name)) defs.set(name, { type: 'histogram', help, buckets, counts: new Array(buckets.length).fill(0), sum: 0, count: 0 });
    },
    observe(name, v) {
      const d = def(name);
      for (let i = 0; i < d.buckets.length; i++) if (v <= d.buckets[i]) d.counts[i]++;
      d.sum += v;
      d.count++;
    },
    get(name, labels = null) {
      const d = defs.get(name);
      return d && d.series ? d.series.get(labelText(labels)) : undefined;
    },
    render() {
      const out = [];
      for (const [name, d] of defs) {
        out.push(`# HELP ${name} ${d.help}`, `# TYPE ${name} ${d.type}`);
        if (d.type === 'histogram') {
          d.buckets.forEach((b, i) => out.push(`${name}_bucket{le="${b}"} ${d.counts[i]}`));
          out.push(`${name}_bucket{le="+Inf"} ${d.count}`, `${name}_sum ${Math.round(d.sum * 1000) / 1000}`, `${name}_count ${d.count}`);
        } else {
          if (!d.series.size) out.push(`${name} 0`);
          for (const [k, v] of d.series) out.push(`${name}${k} ${v}`);
        }
      }
      return out.join('\n') + '\n';
    }
  };
}
