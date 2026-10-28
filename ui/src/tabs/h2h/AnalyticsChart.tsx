import { LineChart, useThemeColors, useChartUITokens } from "@databricks/appkit-ui/react";
import { formatMs } from "../../shared/format";
import type { H2HAnalytics } from "../../api";
export const rowLabel = (rows: number) => rows >= 1_000_000 ? `${rows / 1_000_000}M` : `${rows / 1000}k`;
export function AnalyticsChart({ results }: { results: H2HAnalytics[] }) {
  const palette = useThemeColors("categorical");
  const colors = [palette[0], getComputedStyle(document.documentElement).getPropertyValue("--home-olap-edge").trim()];
  const ui = useChartUITokens();
  const data = results.map(row => ({ rows: rowLabel(row.rows), lakebase: row.lakebase.p50 ?? null, dbsql: row.dbsql.p50 ?? null }));
  return <LineChart data={data} xKey="rows" yKey={["lakebase", "dbsql"]} colorPalette="categorical" height={300} ariaLabel="Full-history aggregation: p50 server time versus row count; linear axis starts at zero" valueFormatter={value => formatMs(Number(value))} options={{
    grid: { left: 0, right: 18, top: 40, bottom: 70, containLabel: true },
    xAxis: { type: "category", data: data.map(row => row.rows), name: "Rows scanned", nameLocation: "middle", nameGap: 30, nameTextStyle: { color: ui.axisTitle }, axisLabel: { color: ui.axisLabel }, axisLine: { lineStyle: { color: ui.grid } }, axisTick: { show: false } },
    yAxis: { type: "value", min: 0, name: "p50 latency (ms / s)", nameTextStyle: { color: ui.axisTitle }, axisLabel: { color: ui.axisLabel, formatter: (value: number) => formatMs(value) }, splitLine: { lineStyle: { color: ui.grid } } },
    legend: { bottom: 0, data: ["Lakebase", "DBSQL"], textStyle: { color: ui.axisLabel } },
    series: (["lakebase", "dbsql"] as const).map((engine, index) => ({ type: "line", name: engine === "lakebase" ? "Lakebase" : "DBSQL", color: colors[index], data: data.map(row => row[engine]), connectNulls: false, symbolSize: 8, smooth: false, tooltip: { valueFormatter: (value: number) => formatMs(value) } })),
  }} />;
}
