import { useCallback, useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, GaugeChart, PieChart, RadarChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';
import { useChartTheme } from '../../hooks/useChartTheme';
import { useLayoutResizing } from '../../hooks/useLayoutResizing';
import { applyChartTheme } from '../../services/annotationQuality/chartTheme';
import { createResizeObserver } from '../../utils/resizeObserver';

echarts.use([
  BarChart,
  PieChart,
  RadarChart,
  GaugeChart,
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  CanvasRenderer,
]);

interface QualityEChartProps {
  option: EChartsOption;
  height?: number;
}

function scheduleChartResize(chart: echarts.ECharts): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      chart.resize();
    });
  });
}

export default function QualityEChart({
  option,
  height = 220,
}: QualityEChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const chartTheme = useChartTheme();
  const isLayoutResizing = useLayoutResizing();

  const resizeChart = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    scheduleChartResize(chart);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;

    const chart = echarts.init(el, undefined, { renderer: 'canvas' });
    chartRef.current = chart;

    const observer = createResizeObserver(() => {
      scheduleChartResize(chart);
    });
    observer?.observe(el);

    return () => {
      observer?.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.setOption(applyChartTheme(option, chartTheme), true);
    resizeChart();
  }, [option, chartTheme, resizeChart]);

  useEffect(() => {
    if (!isLayoutResizing) {
      resizeChart();
    }
  }, [isLayoutResizing, resizeChart]);

  return (
    <div
      ref={containerRef}
      className="quality-echart"
      style={{ width: '100%', height }}
    />
  );
}
