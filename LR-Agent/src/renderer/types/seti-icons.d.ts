declare module 'seti-icons' {
  export interface SetiIconResult {
    svg: string;
    color: string;
  }

  export function getIcon(fileName: string): SetiIconResult;

  export function themeIcons(
    theme: Record<string, string>,
  ): (fileName: string) => SetiIconResult;
}
