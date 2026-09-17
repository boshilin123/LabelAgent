import { useMemo } from 'react';
import { useTheme } from '../context/ThemeContext';
import {
  getChartThemeTokens,
  type ChartThemeTokens,
} from '../services/annotationQuality/chartThemeTokens';

export function useChartTheme(): ChartThemeTokens {
  const { effectiveTheme } = useTheme();
  return useMemo(() => getChartThemeTokens(effectiveTheme), [effectiveTheme]);
}
