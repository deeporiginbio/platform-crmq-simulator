/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

import { createTheme, type MantineThemeOverride } from '@mantine/core';

/**
 * Color palettes from platform-ui/packages/theme/src/theme-values.ts
 * Using the exact DO Design System colors.
 */
const colors = {
  indigo: [
    '#E1E6FF',
    '#CBD6FF',
    '#B4C4FE',
    '#97AAFF',
    '#6987FF',
    '#4B6AF1',
    '#344BF5',
    '#213CE8',
    '#0D25C5',
    '#071B9D',
  ],
  green: [
    '#F3FBF8',
    '#DBF5EB',
    '#B8ECD7',
    '#89E0BD',
    '#4ED09C',
    '#14C17B',
    '#11A468',
    '#0D8655',
    '#0A6943',
    '#084D31',
  ],
  red: [
    '#FDECEC',
    '#FAC5C3',
    '#F7A9A7',
    '#F4827E',
    '#F16965',
    '#EE443F',
    '#D93E39',
    '#A9302D',
    '#832523',
    '#641D1A',
  ],
  yellow: [
    '#FFFCF3',
    '#FFF6DE',
    '#FFEEBE',
    '#FFE392',
    '#FFD55B',
    '#FFC825',
    '#F4B516',
    '#DA9900',
    '#B27700',
    '#7F5000',
  ],
  blue: [
    '#EEF2FF',
    '#E1E7FF',
    '#C9D3FF',
    '#A1B5FF',
    '#8DA5FF',
    '#7995FF',
    '#5B7BF4',
    '#4A65DC',
    '#3852CF',
    '#253EAD',
  ],
  violet: [
    '#F0EAFE',
    '#E6DBFD',
    '#D1BFFC',
    '#B795FA',
    '#9E6FF6',
    '#8C56F2',
    '#7638E5',
    '#5923C2',
    '#451B9A',
    '#341573',
  ],
  grey: [
    '#F9FAFB',
    '#F3F4F6',
    '#E5E7EA',
    '#D2D5DB',
    '#898989',
    '#6D717F',
    '#4D5461',
    '#394050',
    '#212936',
    '#131927',
  ],
  cyan: [
    '#E0F7FA',
    '#B2EBF2',
    '#80DFEA',
    '#4DD1E1',
    '#26C7DA',
    '#00BDD4',
    '#00ADC1',
    '#0098A7',
    '#00848F',
    '#006164',
  ],
};

export const theme: MantineThemeOverride = createTheme({
  // @ts-expect-error custom color arrays are fine
  colors,
  primaryColor: 'indigo',
  fontFamily: '"Source Sans 3", Inter, -apple-system, BlinkMacSystemFont, sans-serif',
  headings: {
    fontFamily: '"Source Sans 3", Inter, -apple-system, BlinkMacSystemFont, sans-serif',
  },
  fontSizes: {
    xs: '12px',
    sm: '12px',
    md: '14px',
    lg: '16px',
    xl: '18px',
  },
  spacing: {
    xs: '12px',
    sm: '16px',
    md: '20px',
    lg: '24px',
    xl: '32px',
  },
  radius: {
    xs: '4px',
    sm: '6px',
    md: '8px',
    lg: '12px',
    xl: '16px',
  },
  defaultRadius: 'md',
  components: {
    Button: {
      defaultProps: {
        size: 'sm',
        variant: 'filled',
        radius: '30px',
      },
    },
  },
});
