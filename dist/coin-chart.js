import { CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, PriceScaleMode, createChart, createSeriesMarkers } from "./vendor/lightweight-charts.js";

const pad = value => String(value).padStart(2, "0");
const localTime = seconds => {
  const date = new Date(seconds * 1000);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const localDateTime = seconds => {
  const date = new Date(seconds * 1000);
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${localTime(seconds)}`;
};

function precisionFor(price) {
  if (!(price > 0)) return 4;
  return price < 0.00001 ? 10 : price < 0.001 ? 8 : price < 0.1 ? 6 : price < 10 ? 4 : 2;
}

/** Candlestick chart with a volume histogram, trade markers and price lines for open positions. */
export function createCoinChart(container) {
  const chart = createChart(container, {
    width: container.clientWidth,
    height: container.clientHeight,
    layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#8d9598", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" },
    grid: { vertLines: { color: "#15181a" }, horzLines: { color: "#15181a" } },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { mode: PriceScaleMode.Logarithmic, borderColor: "#232628", scaleMargins: { top: 0.08, bottom: 0.25 } },
    timeScale: { borderColor: "#232628", timeVisible: true, secondsVisible: false, tickMarkFormatter: localTime },
    localization: { timeFormatter: localDateTime }
  });
  const candles = chart.addSeries(CandlestickSeries, {
    upColor: "#4ade80", downColor: "#f87171", wickUpColor: "#4ade80", wickDownColor: "#f87171", borderVisible: false
  });
  const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "" });
  volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  const markers = createSeriesMarkers(candles, []);
  let priceLines = [];
  let planLines = [];
  let lastCandle = null;

  const observer = new ResizeObserver(() => chart.applyOptions({ width: container.clientWidth, height: container.clientHeight }));
  observer.observe(container);

  return {
    setCandles(data, { fit = false } = {}) {
      const last = data[data.length - 1];
      const precision = precisionFor(last?.close);
      candles.applyOptions({ priceFormat: { type: "price", precision, minMove: 10 ** -precision } });
      candles.setData(data.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
      lastCandle = last ? { time: last.time, open: last.open, high: last.high, low: last.low, close: last.close } : null;
      volume.setData(data.map(({ time, volume: value, open, close }) => ({ time, value, color: close >= open ? "#4ade8055" : "#f8717155" })));
      if (fit) chart.timeScale().fitContent();
    },
    /** Moves the latest candle with the live price, like a streaming chart. */
    tick(price) {
      if (!lastCandle || !(price > 0)) return;
      lastCandle = { ...lastCandle, close: price, high: Math.max(lastCandle.high, price), low: Math.min(lastCandle.low, price) };
      candles.update(lastCandle);
    },
    setMarkers(list) {
      markers.setMarkers(list.map(({ time, position, shape, color, text }) => ({ time, position, shape, color, text, size: 1.4 })));
    },
    setEntryLines(lines) {
      priceLines.forEach(line => candles.removePriceLine(line));
      priceLines = lines.map(({ price, title }) => candles.createPriceLine({ price, title, color: "#fde047", lineStyle: 2, lineWidth: 1, axisLabelVisible: true }));
    },
    /** Plan levels (entry, stop, targets) drawn as dashed lines. */
    setPlanLines(lines) {
      planLines.forEach(line => candles.removePriceLine(line));
      planLines = lines.map(({ price, title, color }) => candles.createPriceLine({ price, title, color, lineStyle: 1, lineWidth: 1, axisLabelVisible: true }));
    },
    destroy() {
      observer.disconnect();
      chart.remove();
    }
  };
}
