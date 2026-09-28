import { useCallback, useEffect, useRef, useState } from 'react';
import type { SettingsPageRequest } from '../features/settings/types';
import type { SectionId } from '../shared/types/navigation';
import type { OfficialAccountState } from '../shared/types/officialAccount';
import { useToast } from '../shared/ui';

// 同一轮并发请求会集中返回余额不足，冷却期内只跳转一次。
const BALANCE_REDIRECT_COOLDOWN_MS = 5 * 60 * 1000;

function parseAvailablePoint(state: OfficialAccountState) {
  return state.availablePoint === null ? Number.NaN : Number(state.availablePoint);
}

// 文本模型不可用时统一跳到设置-文本模型：启动时检查一次配置和官方余额，运行中监听官方余额不足。
export function useTextModelSetupRedirect(requestSectionChange: (section: SectionId) => Promise<boolean>) {
  const [settingsRequest, setSettingsRequest] = useState<SettingsPageRequest | null>(null);
  const { showToast } = useToast();
  const redirectRef = useRef<(openRecharge: boolean, message: string) => void>(() => undefined);

  // 订阅只建立一次，跳转时通过 ref 使用最新的切页函数。
  useEffect(() => {
    redirectRef.current = (openRecharge, message) => {
      showToast(message, 'info');
      // 先写入请求，设置页挂载时直接显示目标分类；离开被拦截时撤回。
      setSettingsRequest({ tab: 'text-model', openRecharge });
      void requestSectionChange('settings').then((allowed) => {
        if (!allowed) setSettingsRequest(null);
      });
    };
  });

  useEffect(() => {
    let disposed = false;
    let balanceRedirectAt = 0;
    let startupBalanceCheck = false;
    let accountEventReceived = false;
    let latestAccount: OfficialAccountState | null = null;
    let lastAvailablePoint = Number.NaN;

    const redirectForBalance = () => {
      if (disposed || Date.now() - balanceRedirectAt < BALANCE_REDIRECT_COOLDOWN_MS) return;
      balanceRedirectAt = Date.now();
      redirectRef.current(true, '易标官方 API 余额不足，请充值后继续使用');
    };

    // 启动余额只判断一次；未登录或余额未知时不跳转，由联网提示和账户页处理。
    const checkStartupBalance = () => {
      if (!startupBalanceCheck || !latestAccount || latestAccount.status === 'loading') return;
      startupBalanceCheck = false;
      if (latestAccount.status === 'signed-in' && parseAvailablePoint(latestAccount) <= 0) redirectForBalance();
    };

    const handleAccountState = (state: OfficialAccountState) => {
      const availablePoint = parseAvailablePoint(state);
      // 充值或兑换到账后余额上升，允许下一次余额不足重新跳转。
      if (availablePoint > lastAvailablePoint) balanceRedirectAt = 0;
      if (Number.isFinite(availablePoint)) lastAvailablePoint = availablePoint;
      latestAccount = state;
      checkStartupBalance();
    };

    const unsubscribeAccount = window.yibiao.officialAccount.onStateChanged((state) => {
      accountEventReceived = true;
      handleAccountState(state);
    });
    void window.yibiao.officialAccount.getState().then((state) => {
      if (!disposed && !accountEventReceived) handleAccountState(state);
    }).catch(() => undefined);
    const unsubscribeBalance = window.yibiao.ai.onBalanceInsufficient(redirectForBalance);

    void window.yibiao.config.load()
      .then((config) => {
        if (disposed) return;
        if (config.text_model_provider === 'official') {
          startupBalanceCheck = true;
          checkStartupBalance();
        } else if (!config.api_key || !config.model_name || !config.base_url) {
          redirectRef.current(false, '文本模型尚未配置，请先完成设置');
        }
      })
      .catch((error) => console.warn('读取文本模型配置失败', error));

    return () => {
      disposed = true;
      unsubscribeAccount();
      unsubscribeBalance();
    };
  }, []);

  const clearSettingsRequest = useCallback(() => setSettingsRequest(null), []);
  return { settingsRequest, clearSettingsRequest };
}
