import { BarChart, buildCartesianOption, useChartUITokens, useThemeColors } from "@databricks/appkit-ui/react";
import { formatMs } from "../../shared/format";
export type ChartRow = { benchmark: string; lakebase: number; dbsql: number };
const formatter = (value: string | number) => formatMs(Number(value));
export function ComparisonChart({ data }: { data: ChartRow[] }) {
  const palette = useThemeColors("categorical");
  const colors = [palette[0], getComputedStyle(document.documentElement).getPropertyValue("--home-olap-edge").trim()];
  const ui = useChartUITokens();
  const axes = buildCartesianOption({ xData: data.map(row => row.benchmark), yDataMap: { lakebase: data.map(row => row.lakebase), dbsql: data.map(row => row.dbsql) }, yFields: ["lakebase", "dbsql"], colors, ui, valueFormatter: formatter, showLegend: true, chartType: "bar", isTimeSeries: false, stacked: false, smooth: false, showSymbol: false, symbolSize: 8 });
  return <BarChart data={data} xKey="benchmark" yKey={["lakebase", "dbsql"]} colorPalette="categorical" height={270} ariaLabel="Read benchmark p50 server latency in milliseconds, Lakebase versus DBSQL; lower is faster" valueFormatter={formatter} options={{
    yAxis: { ...(axes.yAxis as Record<string, unknown>), name: "p50 latency (ms / s)", min: 0 },
    xAxis: { type: "category", data: data.map(row => row.benchmark), axisLabel: { color: ui.axisLabel }, axisLine: { lineStyle: { color: ui.grid } }, axisTick: { show: false } },
    legend: { data: ["Lakebase", "DBSQL"], bottom: 0, textStyle: { color: ui.axisLabel } },
    grid: { left: 0, right: 12, top: 38, bottom: 56, containLabel: true },
    series: (["lakebase", "dbsql"] as const).map((engine, index) => ({ name: engine === "lakebase" ? "Lakebase" : "DBSQL", type: "bar", data: data.map(row => row[engine]), color: colors[index % colors.length], itemStyle: { borderRadius: [3, 3, 0, 0] }, barMaxWidth: 54, tooltip: { valueFormatter: formatter }, label: { show: true, position: "top", color: ui.axisTitle, fontSize: 11, formatter: (params: { value: number }) => params.value === null ? "" : formatMs(params.value) } })),
  }} />;
}
