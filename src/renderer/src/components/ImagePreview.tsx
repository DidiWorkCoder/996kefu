import { useEffect, useRef, useState } from 'react';
import { App as AntApp, Button, Dropdown, Tooltip } from 'antd';
import { RotateLeftOutlined, RotateRightOutlined } from '@ant-design/icons';

interface Props {
  url: string;
  onClose: () => void;
}

/** 图片查看器：滚轮缩放、左键拖动、左右旋转、右键复制、Esc / 点空白关闭 */
export default function ImagePreview({ url, onClose }: Props) {
  const { message } = AntApp.useApp();
  const [scale, setScale] = useState(1);
  /** 旋转角度（顺时针，90 的倍数） */
  const [rotate, setRotate] = useState(0);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const layerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  /** 本次按下是否发生过拖动（拖动结束时的 click 不应关闭查看器） */
  const movedRef = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 滚轮缩放：React 的 onWheel 是 passive 的，必须用原生监听才能 preventDefault
  useEffect(() => {
    const el = layerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setScale((s) => Math.min(8, Math.max(0.2, e.deltaY < 0 ? s * 1.15 : s / 1.15)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // 拖动：鼠标可能在图片外，监听挂在 window 上
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (Math.abs(e.clientX - d.sx) > 2 || Math.abs(e.clientY - d.sy) > 2) movedRef.current = true;
      setPos({ x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) });
    };
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  const copy = async () => {
    try {
      await window.kefu.copyImage(url);
      message.success('图片已复制');
    } catch (e: any) {
      message.error(e?.message || '复制图片失败');
    }
  };

  return (
    <div
      className="img-viewer"
      ref={layerRef}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) movedRef.current = false;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !movedRef.current) onClose();
      }}
    >
      <Dropdown trigger={['contextMenu']} menu={{ items: [{ key: 'copy', label: '复制' }], onClick: copy }}>
        <img
          className="img-viewer-img"
          src={url}
          alt=""
          draggable={false}
          style={{
            transform: `translate(${pos.x}px, ${pos.y}px) rotate(${rotate}deg) scale(${scale})`,
            cursor: dragging ? 'grabbing' : 'grab',
          }}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            movedRef.current = false;
            dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };
            setDragging(true);
          }}
        />
      </Dropdown>
      <div className="img-viewer-tools">
        <Tooltip title="向左旋转 90°">
          <Button
            size="small"
            icon={<RotateLeftOutlined />}
            onClick={() => setRotate((r) => (r - 90 + 360) % 360)}
          />
        </Tooltip>
        <Tooltip title="向右旋转 90°">
          <Button size="small" icon={<RotateRightOutlined />} onClick={() => setRotate((r) => (r + 90) % 360)} />
        </Tooltip>
      </div>
      <div className="img-viewer-tip">滚轮缩放 · 左键拖动 · 左右旋转 · 右键复制 · Esc 或点空白处关闭</div>
    </div>
  );
}
