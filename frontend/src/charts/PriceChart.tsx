import {
  CandlestickSeries, ColorType, createChart, CrosshairMode, HistogramSeries, LineSeries,
  type IChartApi, type IPriceLine, type ISeriesApi, type LogicalRange, type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { CandlesResponse } from "@/services/api";

// Read design tokens so the chart follows the theme.
function token(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

const OVERLAYS: Record<string, string> = { sma20: "#5b8def", sma50: "#b07cf0", ema20: "#e5b454", ema50: "#f07ca8" };

const SUB_PANE = 120;

const TF_SECONDS: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
type Bar = { time: UTCTimestamp; open: number; high: number; low: number; close: number };

export interface ChartPriceLine { id: string; price: number; title: string; color: string }


/**
 * Candlestick chart. With `live`, the last candle ticks with every streamed quote and a new
 * candle opens when the timeframe rolls over, without rebuilding the chart (zoom is kept).
 */
export function PriceChart({ data, decimals, height: mainHeight = 420, live, priceLines = [], testId = "price-chart" }: {
  data: CandlesResponse; decimals: number; height?: number; live?: { price: number; at: string } | null;
  priceLines?: ChartPriceLine[]; testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lastBar = useRef<Bar | null>(null);
  const range = useRef<{ key: string; range: LogicalRange | null } | null>(null);
  const subPanes = (data.indicators.rsi14 ? 1 : 0) + (data.indicators.macd ? 1 : 0);
  const height = mainHeight + subPanes * SUB_PANE;
  const chartRef = useRef<IChartApi | null>(null);
  const priceLineRef = useRef<IPriceLine[]>([]);
  const priceLinesRef = useRef(priceLines);
  priceLinesRef.current = priceLines;
  const linesKey = priceLines.map((l) => `${l.id}:${l.price}:${l.title}:${l.color}`).join("|");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const up = token("--color-positive");
    const down = token("--color-negative");
    const grid = token("--color-border");
    const chart = createChart(el, {
      height,
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: token("--color-muted"),
        fontFamily: "JetBrains Mono Variable, ui-monospace, monospace",
        fontSize: 11,
        panes: { separatorColor: grid, separatorHoverColor: token("--color-border-strong") },
      },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: grid },
      timeScale: { borderColor: grid, timeVisible: data.timeframe !== "1d", secondsVisible: false },
      localization: { priceFormatter: (p: number) => p.toFixed(decimals) },
    });
    chartRef.current = chart;

    const t = (iso: string) => (Date.parse(iso) / 1000) as UTCTimestamp;
    const times = data.candles.map((c) => t(c.open_time));
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down,
      priceFormat: { type: "price", precision: decimals, minMove: 1 / 10 ** decimals },
    });
    const bars = data.candles.map((c, i) => ({ time: times[i]!, open: +c.open, high: +c.high, low: +c.low, close: +c.close }));
    candles.setData(bars);
    seriesRef.current = candles;
    priceLineRef.current = priceLinesRef.current.map((l) => candles.createPriceLine({
      price: l.price, color: l.color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: l.title,
    }));
    lastBar.current = bars.length ? { ...bars[bars.length - 1]! } : null;

    const vol = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    vol.setData(data.candles.map((c, i) => ({
      time: times[i]!, value: +c.volume,
      color: (+c.close >= +c.open ? up : down) + "55",
    })));

    const line = (values: (number | null)[], color: string, pane = 0, width: 1 | 2 = 1) => {
      const s = chart.addSeries(LineSeries, { color, lineWidth: width, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, pane);
      s.setData(values.flatMap((v, i) => (v == null ? [] : [{ time: times[i]!, value: v }])));
      return s;
    };
    for (const [k, color] of Object.entries(OVERLAYS)) {
      const v = data.indicators[k as keyof typeof OVERLAYS & keyof CandlesResponse["indicators"]];
      if (Array.isArray(v)) line(v, color, 0, 2);
    }
    if (data.indicators.bb20) {
      const bb = data.indicators.bb20;
      line(bb.upper, token("--color-subtle"));
      line(bb.middle, token("--color-subtle"));
      line(bb.lower, token("--color-subtle"));
    }
    let pane = 1;
    if (data.indicators.rsi14) {
      const rsi = line(data.indicators.rsi14, token("--color-accent"), pane, 1);
      rsi.createPriceLine({ price: 70, color: down, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "" });
      rsi.createPriceLine({ price: 30, color: up, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "" });
      pane++;
    }
    if (data.indicators.macd) {
      const m = data.indicators.macd;
      const hist = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane);
      hist.setData(m.histogram.flatMap((v, i) => (v == null ? [] : [{ time: times[i]!, value: v, color: (v >= 0 ? up : down) + "99" }])));
      line(m.macd, token("--color-info"), pane);
      line(m.signal, token("--color-warning"), pane);
      pane++;
    }
    // Proportional sizing: stretch factors are relative, so use pixel targets as weights.
    chart.panes().forEach((p, i) => p.setStretchFactor(i === 0 ? mainHeight : SUB_PANE));
    const key = `${data.symbol}|${data.timeframe}|${subPanes}`;
    if (range.current?.key === key && range.current.range) chart.timeScale().setVisibleLogicalRange(range.current.range);
    else chart.timeScale().fitContent();
    return () => {
      range.current = { key, range: chart.timeScale().getVisibleLogicalRange() };   // keep the zoom across refetches
      priceLineRef.current = [];
      chart.remove(); chartRef.current = null; seriesRef.current = null;
    };
  }, [data, decimals, height, mainHeight, subPanes, linesKey]);

  useEffect(() => {
    const series = seriesRef.current, prev = lastBar.current;
    if (!live || !series || !prev) return;
    const step = TF_SECONDS[data.timeframe] ?? 3600;
    const t = Math.floor(Date.parse(live.at) / 1000);
    if (t < prev.time) return;                                   // older than the last candle
    const bucket = (Math.floor(t / step) * step) as UTCTimestamp;
    const next: Bar = bucket > prev.time
      ? { time: bucket, open: prev.close, high: Math.max(prev.close, live.price), low: Math.min(prev.close, live.price), close: live.price }
      : { ...prev, high: Math.max(prev.high, live.price), low: Math.min(prev.low, live.price), close: live.price };
    series.update(next);
    lastBar.current = next;
  }, [live, data.timeframe]);

  return <div ref={ref} className="w-full" style={{ height }} data-testid={testId} />;
}
