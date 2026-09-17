import { useState } from 'react';
import './PasswordField.css';

interface PasswordFieldProps {
  id: string;
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  minLength?: number;
  required?: boolean;
}

export default function PasswordField({
  id,
  name,
  label,
  value,
  onChange,
  autoComplete,
  minLength,
  required = false,
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="auth-field">
      <span className="auth-field-label">{label}</span>
      <div className="auth-password-wrap">
        <input
          id={id}
          name={name}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          minLength={minLength}
          required={required}
          className="auth-password-input"
        />
        <button
          type="button"
          className="auth-password-toggle"
          aria-label={visible ? '隐藏密码' : '显示密码'}
          aria-pressed={visible}
          onClick={() => setVisible((current) => !current)}
        >
          <span
            className={`codicon ${visible ? 'codicon-eye-closed' : 'codicon-eye'}`}
            aria-hidden="true"
          />
        </button>
      </div>
    </div>
  );
}
