/** 掉线类错误：token 被顶掉 / 未登录 */
const OFFLINE_RE = /登录已失效|掉线|token无效|token失效|未登录|请重新登录/;

/** 是否为「客服号掉线」类错误 */
export function isOfflineError(err: unknown): boolean {
  return OFFLINE_RE.test(String((err as any)?.message || err || ''));
}

/** 只用到 error / warning 两个方法，避免依赖 antd 内部类型 */
interface MessageApi {
  error: (content: string) => void;
  warning: (content: string) => void;
}

/**
 * 统一的接口错误提示：
 * 掉线是预期内的业务状态，用友好的黄色提示，并通知 App 显示顶部「续期」按钮；
 * 其它错误照原样红字提示。
 */
export function showApiError(api: MessageApi, err: unknown, fallback: string): void {
  if (isOfflineError(err)) {
    window.dispatchEvent(new CustomEvent('kefu:offline'));
    api.warning('客服号已掉线，请点该账号的「续期」重新上线');
    return;
  }
  api.error(String((err as any)?.message || err || '') || fallback);
}
