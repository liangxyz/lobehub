import { DEFAULT_AVATAR } from '@lobechat/const';
import { type ListItemProps } from '@lobehub/ui';
import { List } from '@lobehub/ui';
import { Avatar } from '@lobehub/ui/base-ui';
import { useHover } from 'ahooks';
import { createStaticStyles, cx } from 'antd-style';
import { memo, useMemo, useRef } from 'react';

import GroupAvatar from '@/features/GroupAvatar';
import { useServerConfigStore } from '@/store/serverConfig';

const { Item } = List;

const styles = createStaticStyles(({ css, cssVar }) => {
  return {
    container: css`
      position: relative;
      margin-block: 2px;
      padding-inline: 12px 16px;
      border-radius: ${cssVar.borderRadius};
    `,
    mobile: css`
      margin-block: 0;
      padding-inline-start: 12px;
      border-radius: 0;
    `,
    title: css`
      line-height: 1.2;
    `,
  };
});

export const resolveSessionAvatar = (
  avatar?: string | { avatar: string; background?: string }[] | null,
): string => {
  if (typeof avatar === 'string' && avatar) return avatar;
  if (Array.isArray(avatar) && avatar.length > 0 && avatar[0]?.avatar) return avatar[0].avatar;
  return DEFAULT_AVATAR;
};

const ListItem = memo<
  Omit<ListItemProps, 'avatar' | 'key'> & {
    avatar?: string | { avatar: string; background?: string }[];
    avatarBackground?: string;
    type?: 'agent' | 'group' | 'inbox';
  }
>(({ avatar, avatarBackground, active, showAction, actions, title, type, ...props }) => {
  const ref = useRef(null);
  const isHovering = useHover(ref);
  const mobile = useServerConfigStore((s) => s.isMobile);

  const avatarRender = useMemo(() => {
    if (type === 'group') {
      const avatars = Array.isArray(avatar) ? avatar : avatar ? [avatar] : [];
      return <GroupAvatar avatars={avatars} size={40} />;
    }

    // For regular sessions/agents, use the regular Avatar component with fallback
    const agentAvatar = resolveSessionAvatar(avatar);

    return (
      <Avatar animation={isHovering} avatar={agentAvatar} background={avatarBackground} size={40} />
    );
  }, [isHovering, avatar, avatarBackground, type]);

  return (
    <Item
      actions={actions}
      active={mobile ? false : active}
      avatar={avatarRender}
      className={cx(styles.container, mobile && styles.mobile)}
      ref={ref}
      showAction={actions && (isHovering || showAction || mobile)}
      title={<span className={styles.title}>{title}</span>}
      {...(props as any)}
    />
  );
});

export default ListItem;
