import { applyChartTheme } from '../chartTheme';
import { getChartThemeTokens } from '../chartThemeTokens';

describe('chartThemeTokens', () => {
  it('uses chart-tuned light palette for light theme', () => {
    const tokens = getChartThemeTokens('light');
    expect(tokens.palette).toEqual([
      '#4A9EE8',
      '#52C452',
      '#F0A050',
      '#F06060',
      '#C080E0',
      '#40C8B0',
      '#E8C040',
      '#90D890',
      '#70C8FF',
      '#F09090',
    ]);
    expect(tokens.exportBackground).toBe('#ffffff');
  });

  it('uses dark palette for dark theme', () => {
    const tokens = getChartThemeTokens('dark');
    expect(tokens.palette[0]).toBe('#5299e0');
    expect(tokens.exportBackground).toBe('#1e1e1e');
  });

  it('provides chart-tuned structural colors per theme', () => {
    const light = getChartThemeTokens('light');
    const dark = getChartThemeTokens('dark');

    expect(light.text.primary).toBe('#333333');
    expect(dark.text.primary).toBe('#cccccc');
    expect(light.semantic.success).toBe('#52C452');
    expect(dark.semantic.success).toBe('#6cc76c');
    expect(dark.axis.line).toBe('#555555');
    expect(dark.axis.splitLine).toBe('#3e3e42');
    expect(dark.semantic.muted).toBe('#666666');
    expect(light.axis.line).toBe('#cccccc');
  });
});

describe('applyChartTheme', () => {
  it('preserves original grid and tooltip trigger settings', () => {
    const tokens = getChartThemeTokens('light');
    const option = {
      grid: { left: 40, right: 16, bottom: 48, top: 32 },
      tooltip: {
        trigger: 'axis' as const,
        axisPointer: { type: 'shadow' as const },
      },
      xAxis: { type: 'category' as const, data: ['a', 'b'] },
      yAxis: { type: 'value' as const },
      series: [{ type: 'bar' as const, data: [1, 2] }],
    };

    const themed = applyChartTheme(option, tokens);

    expect(themed.grid).toEqual(option.grid);
    expect((themed.tooltip as { trigger?: string } | undefined)?.trigger).toBe(
      'axis',
    );
    expect(themed.color).toEqual(tokens.palette);
  });

  it('maps pie themeRole values to semantic colors', () => {
    const tokens = getChartThemeTokens('light');
    const option = {
      series: [
        {
          type: 'pie' as const,
          data: [
            { name: '已标注', value: 8, themeRole: 'success' as const },
            { name: '未标注', value: 2, themeRole: 'muted' as const },
          ],
        },
      ],
    };

    const themed = applyChartTheme(option, tokens);
    const series = Array.isArray(themed.series)
      ? themed.series[0]
      : themed.series;
    const data =
      (series as { data?: Array<Record<string, unknown>> }).data ?? [];

    expect(data[0]?.itemStyle).toEqual({ color: tokens.semantic.success });
    expect(data[1]?.itemStyle).toEqual({ color: tokens.semantic.muted });
    expect(data[0]).not.toHaveProperty('themeRole');
    expect(data[1]).not.toHaveProperty('themeRole');
  });

  it('sets explicit radar data label colors', () => {
    const tokens = getChartThemeTokens('dark');
    const option = {
      series: [
        {
          type: 'radar' as const,
          data: [
            {
              value: [0.8, 0.6],
              name: '质量维度',
              label: { show: true, fontSize: 10 },
            },
          ],
        },
      ],
    };

    const themed = applyChartTheme(option, tokens);
    const series = Array.isArray(themed.series)
      ? themed.series[0]
      : themed.series;
    const data =
      (series as { data?: Array<Record<string, unknown>> }).data ?? [];

    expect((data[0]?.label as { color?: string })?.color).toBe('#cccccc');
  });
});
