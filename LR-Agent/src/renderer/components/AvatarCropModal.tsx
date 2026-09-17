import { useCallback, useState } from 'react';
import Cropper, { Area } from 'react-easy-crop';
import { VscodeButton } from '@vscode-elements/react-elements';
import { getCroppedImageBlob, type PixelCrop } from '../utils/cropImage';
import ModalMotion from '../motion/ModalMotion';
import './AvatarCropModal.css';

interface AvatarCropModalProps {
  imageSrc: string;
  onCancel: () => void;
  onConfirm: (file: File) => void;
}

export default function AvatarCropModal({
  imageSrc,
  onCancel,
  onConfirm,
}: AvatarCropModalProps) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<PixelCrop | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onCropComplete = useCallback((_: Area, pixels: Area) => {
    setCroppedAreaPixels(pixels);
  }, []);

  const handleConfirm = async () => {
    if (!croppedAreaPixels) return;
    setSubmitting(true);
    setError(null);
    try {
      const blob = await getCroppedImageBlob(imageSrc, croppedAreaPixels);
      const file = new File([blob], 'avatar.png', { type: 'image/png' });
      onConfirm(file);
    } catch {
      setError('裁剪失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalMotion
      open
      onClose={onCancel}
      dialogClassName="avatar-crop-dialog"
      labelledBy="avatar-crop-title"
    >
      <h3 id="avatar-crop-title" className="avatar-crop-title">
        调整头像
      </h3>
      <p className="avatar-crop-hint">拖动图片调整位置，滑块缩放大小</p>

      <div className="avatar-crop-area">
        <Cropper
          image={imageSrc}
          crop={crop}
          zoom={zoom}
          aspect={1}
          cropShape="round"
          showGrid={false}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={onCropComplete}
        />
      </div>

      <label className="avatar-crop-zoom-label" htmlFor="avatar-crop-zoom">
        缩放
      </label>
      <input
        id="avatar-crop-zoom"
        type="range"
        min={1}
        max={3}
        step={0.05}
        value={zoom}
        onChange={(e) => setZoom(Number(e.target.value))}
        className="avatar-crop-zoom"
      />

      {error && <p className="avatar-crop-error">{error}</p>}

      <div className="avatar-crop-actions">
        <VscodeButton
          secondary
          icon="close"
          type="button"
          disabled={submitting}
          onClick={onCancel}
        >
          取消
        </VscodeButton>
        <VscodeButton
          icon="check"
          type="button"
          disabled={submitting || !croppedAreaPixels}
          onClick={handleConfirm}
        >
          {submitting ? '处理中…' : '确认'}
        </VscodeButton>
      </div>
    </ModalMotion>
  );
}
