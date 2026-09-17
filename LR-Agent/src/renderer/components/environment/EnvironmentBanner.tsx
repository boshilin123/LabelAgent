import { useEffect } from 'react';
import { useEnvironment } from '../../context/EnvironmentContext';
import './EnvironmentBanner.css';

/**
 * 环境缺失提示横幅：向导已展示（seen/completed/dismissed）后，仅在关键环境
 * （local-agent / inference）缺失时出现；点击重开环境向导。
 */
export default function EnvironmentBanner() {
  const { status, refresh, openWizard, wizardOpen } = useEnvironment();

  useEffect(() => {
    const unsubscribe = window.electron?.env?.onInstallProgress?.(
      (progress) => {
        if (progress.stage === 'done') {
          refresh().catch(() => undefined);
        }
      },
    );
    return () => unsubscribe?.();
  }, [refresh]);

  if (!status || wizardOpen) return null;
  if (!status.settings.firstRunSeenAt) {
    // 首次登录由 Layout 自动拉起向导，不显示横幅
    return null;
  }

  const localAgentMissing =
    !status.localAgent.pythonOk && !status.localAgent.depsInstalled;
  const inferenceMissing = !status.inference.pythonOk;

  if (!localAgentMissing && !inferenceMissing) return null;

  const parts: string[] = [];
  if (localAgentMissing) parts.push('Agent 编排服务');
  if (inferenceMissing) parts.push('推理服务');

  return (
    <div className="env-banner" role="status">
      <span>{parts.join('、')}环境未就绪，相关功能暂不可用。</span>
      <button type="button" className="env-banner-btn" onClick={openWizard}>
        环境检测与安装
      </button>
    </div>
  );
}
