import type { EChartsOption } from 'echarts';
import {
  resolveSemanticColor,
  type ChartSemanticRole,
  type ChartThemeTokens,
} from './chartThemeTokens';

type AxisOption =
  NonNullable<EChartsOption['xAxis']> extends (infer T)[]
    ? T
    : NonNullable<EChartsOption['xAxis']>;

type SeriesItem =
  NonNullable<EChartsOption['series']> extends (infer T)[]
    ? T
    : NonNullable<EChartsOption['series']>;

type PieDataItem = {
  name?: string;
  value?: number;
  themeRole?: ChartSemanticRole;
  itemStyle?: { color?: string };
};

function themeAxis(
  axis: AxisOption | Record<string, unknown>,
  tokens: ChartThemeTokens,
) {
  const axisLabel =
    axis && typeof axis === 'object' && 'axisLabel' in axis && axis.axisLabel
      ? axis.axisLabel
      : undefined;
  const nameTextStyle =
    axis &&
    typeof axis === 'object' &&
    'nameTextStyle' in axis &&
    axis.nameTextStyle
      ? axis.nameTextStyle
      : undefined;

  return {
    ...axis,
    axisLine: { lineStyle: { color: tokens.axis.line, width: 1 } },
    axisTick: { lineStyle: { color: tokens.axis.line } },
    axisLabel: {
      ...(typeof axisLabel === 'object' ? axisLabel : {}),
      color: tokens.text.primary,
    },
    nameTextStyle: {
      ...(typeof nameTextStyle === 'object' ? nameTextStyle : {}),
      color: tokens.text.primary,
    },
    splitLine: { lineStyle: { color: tokens.axis.splitLine, width: 0.5 } },
  };
}

function resolvePieData(data: unknown, tokens: ChartThemeTokens): unknown {
  if (!Array.isArray(data)) return data;

  return data.map((item) => {
    if (!item || typeof item !== 'object') return item;

    const pieItem = item as PieDataItem;
    if (!pieItem.themeRole) return item;

    const { themeRole, ...rest } = pieItem;
    void themeRole;
    return {
      ...rest,
      itemStyle: {
        ...pieItem.itemStyle,
        color: resolveSemanticColor(tokens, pieItem.themeRole),
      },
    };
  });
}

function usesInsidePieLabels(data: unknown): boolean {
  if (!Array.isArray(data) || data.length === 0) return false;
  return data.every(
    (item) =>
      item &&
      typeof item === 'object' &&
      'themeRole' in item &&
      (item as PieDataItem).themeRole != null,
  );
}

function themeRadarData(data: unknown, tokens: ChartThemeTokens): unknown {
  if (!Array.isArray(data)) return data;

  return data.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;

    const radarData = entry as Record<string, unknown> & {
      label?: Record<string, unknown>;
    };
    const baseLabel =
      typeof radarData.label === 'object' ? radarData.label : {};

    return {
      ...radarData,
      label: {
        ...baseLabel,
        color: tokens.text.primary,
      },
    };
  });
}

function themeSeries(
  series: EChartsOption['series'],
  tokens: ChartThemeTokens,
): EChartsOption['series'] {
  if (!series) return series;
  const list = Array.isArray(series) ? series : [series];

  return list.map((item) => {
    if (!item || typeof item !== 'object') return item;

    if (item.type === 'bar') {
      const barItem = { ...item } as Record<string, unknown> & {
        itemStyle?: Record<string, unknown>;
        emphasis?: Record<string, unknown>;
      };
      barItem.itemStyle = {
        ...barItem.itemStyle,
        borderRadius: [4, 4, 0, 0],
      };
      barItem.emphasis = {
        ...barItem.emphasis,
        itemStyle: {
          ...((barItem.emphasis?.itemStyle as Record<string, unknown>) || {}),
          shadowBlur: 8,
          shadowColor: tokens.emphasis.shadowColor,
          shadowOffsetY: 2,
        },
      };
      return barItem as SeriesItem;
    }

    if (item.type === 'pie') {
      const pieItem = { ...item } as Record<string, unknown> & {
        data?: unknown;
        label?: Record<string, unknown>;
        labelLine?: Record<string, unknown>;
        emphasis?: Record<string, unknown>;
      };

      pieItem.data = resolvePieData(pieItem.data, tokens);
      const baseLabel = typeof pieItem.label === 'object' ? pieItem.label : {};
      const insideLabels = usesInsidePieLabels(pieItem.data);
      pieItem.label = {
        ...baseLabel,
        color: tokens.text.primary,
        ...(insideLabels || baseLabel.position ? {} : { position: 'outside' }),
      };
      pieItem.labelLine = {
        ...pieItem.labelLine,
        show: insideLabels
          ? ((pieItem.labelLine?.show as boolean | undefined) ?? false)
          : ((pieItem.labelLine?.show as boolean | undefined) ?? true),
        lineStyle: {
          ...((pieItem.labelLine?.lineStyle as Record<string, unknown>) || {}),
          color: tokens.pie.labelLine,
          width: 1,
        },
      };
      pieItem.emphasis = {
        ...pieItem.emphasis,
        scaleSize: 8,
        label: {
          ...((pieItem.emphasis?.label as Record<string, unknown>) || {}),
          color: tokens.text.primary,
          fontWeight: 'bold',
          fontSize: 13,
        },
      };
      return pieItem as SeriesItem;
    }

    if (item.type === 'radar') {
      const radarItem = { ...item } as Record<string, unknown> & {
        data?: unknown;
        areaStyle?: Record<string, unknown>;
        lineStyle?: Record<string, unknown>;
        emphasis?: Record<string, unknown>;
      };
      radarItem.data = themeRadarData(radarItem.data, tokens);
      radarItem.areaStyle = {
        ...radarItem.areaStyle,
        opacity: tokens.radar.areaOpacity,
      };
      radarItem.lineStyle = {
        ...radarItem.lineStyle,
        width: 2,
      };
      radarItem.emphasis = {
        ...radarItem.emphasis,
        lineStyle: {
          ...((radarItem.emphasis?.lineStyle as Record<string, unknown>) || {}),
          width: 3,
        },
      };
      return radarItem as SeriesItem;
    }

    return item;
  }) as EChartsOption['series'];
}

export function applyChartTheme(
  option: EChartsOption,
  tokens: ChartThemeTokens,
): EChartsOption {
  const baseTooltip =
    typeof option.tooltip === 'object' && !Array.isArray(option.tooltip)
      ? option.tooltip
      : {};
  const baseTitle =
    typeof option.title === 'object' && !Array.isArray(option.title)
      ? option.title
      : {};
  const baseLegend =
    option.legend &&
    typeof option.legend === 'object' &&
    !Array.isArray(option.legend)
      ? option.legend
      : {};

  return {
    ...option,
    color: tokens.palette,
    backgroundColor: 'transparent',
    textStyle: {
      ...(typeof option.textStyle === 'object' ? option.textStyle : {}),
      color: tokens.text.primary,
    },
    animationDuration: option.animationDuration ?? 800,
    animationEasing: option.animationEasing ?? ('cubicOut' as const),
    tooltip: {
      ...baseTooltip,
      backgroundColor: tokens.tooltip.bg,
      borderColor: tokens.tooltip.border,
      borderWidth: 1,
      borderRadius: 6,
      textStyle: {
        ...(typeof baseTooltip.textStyle === 'object'
          ? baseTooltip.textStyle
          : {}),
        color: tokens.text.primary,
        fontSize: 12,
      },
      extraCssText: `box-shadow: ${tokens.tooltip.shadow};`,
    },
    title: {
      ...baseTitle,
      textStyle: {
        ...(typeof baseTitle.textStyle === 'object' ? baseTitle.textStyle : {}),
        color: tokens.text.primary,
        fontSize: 13,
        fontWeight: 600,
      },
    },
    legend: {
      ...baseLegend,
      textStyle: {
        ...(typeof baseLegend.textStyle === 'object'
          ? baseLegend.textStyle
          : {}),
        color: tokens.text.primary,
        fontSize:
          typeof baseLegend.textStyle === 'object' &&
          baseLegend.textStyle.fontSize != null
            ? baseLegend.textStyle.fontSize
            : 11,
      },
    },
    xAxis: Array.isArray(option.xAxis)
      ? option.xAxis.map((axis) => themeAxis(axis as AxisOption, tokens))
      : option.xAxis
        ? themeAxis(option.xAxis as AxisOption, tokens)
        : option.xAxis,
    yAxis: (Array.isArray(option.yAxis)
      ? option.yAxis.map((axis) =>
          themeAxis(axis as Record<string, unknown>, tokens),
        )
      : option.yAxis
        ? themeAxis(option.yAxis as Record<string, unknown>, tokens)
        : option.yAxis) as EChartsOption['yAxis'],
    series: themeSeries(option.series, tokens),
    radar: option.radar
      ? {
          ...option.radar,
          axisName: {
            ...(typeof option.radar === 'object' &&
            option.radar &&
            'axisName' in option.radar &&
            typeof option.radar.axisName === 'object'
              ? option.radar.axisName
              : {}),
            color: tokens.text.primary,
            fontSize: 11,
          },
          splitLine: {
            lineStyle: { color: tokens.axis.splitLine, width: 0.5 },
          },
          splitArea: {
            areaStyle: {
              color: tokens.radar.splitArea,
            },
          },
        }
      : option.radar,
  };
}
