/**
 * Demo "AI output": an abstract, programmatic image with no face or likeness, clearly labelled
 * as a placeholder, so the demo never shows a real person.
 */
export async function placeholderImage(seed: number, width = 768, height = 512): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('canvas is not available');

  const hue = (seed * 47) % 360;
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, `hsl(${hue} 70% 45%)`);
  gradient.addColorStop(1, `hsl(${(hue + 80) % 360} 70% 30%)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  context.globalAlpha = 0.18;
  context.fillStyle = '#ffffff';
  for (let x = -height; x < width; x += 36) {
    context.beginPath();
    context.moveTo(x, height);
    context.lineTo(x + height, 0);
    context.lineTo(x + height + 14, 0);
    context.lineTo(x + 14, height);
    context.fill();
  }

  context.globalAlpha = 1;
  context.fillStyle = 'rgba(0, 0, 0, 0.45)';
  context.fillRect(0, height - 64, width, 64);
  context.fillStyle = '#ffffff';
  context.font = '600 22px system-ui, sans-serif';
  context.fillText('Placeholder for AI output · not a real person', 24, height - 26);

  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob === null ? reject(new Error('could not render the image')) : resolve(blob)), 'image/png'),
  );
}
