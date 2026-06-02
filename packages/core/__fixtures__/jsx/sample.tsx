import React from 'react';

export function Button(props: { label: string }) {
  return <button>{props.label}</button>;
}

const Card: React.FC<{ title: string }> = ({ title }) => {
  return <div>{title}</div>;
};

export function helper() {
  return 'not a component';
}
