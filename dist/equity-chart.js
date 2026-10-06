import { locale } from "./i18n.js";
import { AreaSeries, ColorType, createChart } from "./vendor/lightweight-charts.js";

const UP = { line: "#4ade80", top: "rgba(74, 222, 128, 0.28)", bottom: "rgba(74, 222, 128, 0.02)" };
const DOWN = { line: "#f87171", top: "rgba(248, 113, 113, 0.28)", bottom: "rgba(248, 113, 113, 0.02)" };
const pad = value => String(value).padStart(2, "0");
const localTime = seconds => { const date = new Date(seconds * 1000); return `${pad(date.getHours())}:${pad(date.getMinutes())}`; };

/** Area chart of the portfolio value over time, colored by whether it is above its starting point. */
export function createEquityChart(container, baseline) {
  const chart = createChart(container, {
    width: container.clientWidth, height: container.clientHeight,
    layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#8d9598", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" },
    grid: { vertLines: { visible: false }, horzLines: { color: "#15181a" } },
    rightPriceScale: { borderColor: "#232628" },
    timeScale: { borderColor: "#232628", timeVisible: true, secondsVisible: false, tickMarkFormatter: localTime },
    localization: { timeFormatter: seconds => `${pad(new Date(seconds * 1000).getDate())}/${pad(new Date(seconds * 1000).getMonth() + 1)} ${localTime(seconds)}`, priceFormatter: price => `${price.toLocaleString(locale, { maximumFractionDigits: 0 })} $` }
  });
  const series = chart.addSeries(AreaSeries, { lineWidth: 2, priceLineVisible: true, lastValueVisible: true });
  series.createPriceLine({ price: baseline, color: "#596164", lineStyle: 2, lineWidth: 1, axisLabelVisible: false, title: "départ" });
  const observer = new ResizeObserver(() => chart.applyOptions({ width: container.clientWidth, height: container.clientHeight }));
  observer.observe(container);
  let first = baseline;

  const toData = points => {
    const data = [];
    for (const point of points) {
      const time = Math.floor(point.t / 1000);
      if (data.length && data[data.length - 1].time >= time) data[data.length - 1] = { time: data[data.length - 1].time, value: point.v };
      else data.push({ time, value: point.v });
    }
    return data;
  };
  const colorize = value => {
    const palette = value >= first ? UP : DOWN;
    series.applyOptions({ lineColor: palette.line, topColor: palette.top, bottomColor: palette.bottom });
  };

  return {
    setData(points) {
      first = points.length ? points[0].v : baseline;
      series.setData(toData(points));
      colorize(points.length ? points[points.length - 1].v : baseline);
      chart.timeScale().fitContent();
    },
    update(point) {
      series.update({ time: Math.floor(point.t / 1000), value: point.v });
      colorize(point.v);
    },
    destroy() { observer.disconnect(); chart.remove(); }
  };
}
