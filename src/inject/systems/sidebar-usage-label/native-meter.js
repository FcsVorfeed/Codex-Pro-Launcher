(() => {
  // 只读取原生额度组件的数值，不保存账号信息或请求另一套额度。
  // Read numeric native-meter props without retaining account data or requesting separate quota.
  const runtime = window.__codexProRuntime;
  if (!runtime) return;

  // 沿用原生主圆环顺序；积分余额没有百分比分母，不能转换为百分比。
  // Follow the native primary ring order; credit balances have no percentage denominator.
  function formatRemaining(props) {
    const kind = props.source?.kind;
    if (kind !== "included" && kind !== "reserve" && kind != null) return null;
    const value = kind === "reserve"
      ? props.reserveRemaining
      : props.remaining?.fiveHour ?? props.remaining?.weekly;
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
      ? `${Math.round(value)}%`
      : "--%";
  }

  // 双分支上溯时检查共享 child，React bailout 的 return 链不一定指向当前根。
  // Resolve both branches with shared-child checks; bailout return links may lead to the old root.
  function currentFiber(fiber) {
    const alternate = fiber.alternate;
    if (!alternate) return fiber;
    let a = fiber;
    let b = alternate;
    while (a.return) {
      const parentA = a.return;
      const parentB = parentA.alternate;
      if (!parentB) {
        // 跳过没有 alternate 的中间包装，继续寻找能区分两支的祖先。
        // Skip an intermediate wrapper without an alternate to find a distinguishing ancestor.
        if (!parentA.return) break;
        a = b = parentA.return;
        continue;
      }
      if (parentA.child === parentB.child) {
        // 两个父版本共享 child 时，实际挂在 sibling 链上的分支就是当前版本。
        // Shared child lists identify the committed branch directly through sibling membership.
        for (let child = parentA.child; child; child = child.sibling) {
          if (child === a) return fiber;
          if (child === b) return alternate;
        }
        return null;
      }
      if (a.return !== b.return) {
        a = parentA;
        b = parentB;
      } else {
        // 相同 return 可能来自复用子树，用两边的实际 child 列表恢复归属。
        // Equal return links can belong to reused subtrees; recover ownership from both child lists.
        let owner = null;
        for (const parent of [parentA, parentB]) {
          for (let child = parent.child; child; child = child.sibling) {
            if (child === a || child === b) {
              owner = { parent, matchesA: child === a };
              break;
            }
          }
          if (owner) break;
        }
        if (!owner) return null;
        const other = owner.parent === parentA ? parentB : parentA;
        a = owner.matchesA ? owner.parent : other;
        b = owner.matchesA ? other : owner.parent;
      }
      if (a.alternate !== b) return null;
    }
    // 只接受挂在已提交 HostRoot 下的版本，不猜测卸载或异常树中的数据。
    // Accept only the committed HostRoot branch, without guessing in detached or invalid trees.
    return a.stateNode?.current === a ? fiber : a.stateNode?.current === b ? alternate : null;
  }

  // 先在局部父链识别额度组件，再解析该组件的当前版本，避免叶节点复用干扰。
  // Identify the quota component locally, then resolve its committed version independently of reused leaves.
  function readIndicator(indicator) {
    let fiber = indicator[Object.keys(indicator).find((key) => key.startsWith("__reactFiber$"))];
    for (let depth = 0; fiber && depth < 24; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (props && Object.hasOwn(props, "source") && Object.hasOwn(props, "remaining") &&
          Object.hasOwn(props, "reserveRemaining") && Object.hasOwn(props, "creditBalance")) {
        const current = currentFiber(fiber);
        return current ? { text: formatRemaining(current.memoizedProps) } : null;
      }
    }
    return null;
  }

  // 模块仅公开读取和格式化能力，UI 生命周期由本系统入口管理。
  // Expose reading and formatting only; the system entry owns the UI lifecycle.
  runtime.systemModules.sidebarUsageLabel = { readIndicator, formatRemaining };
})();
