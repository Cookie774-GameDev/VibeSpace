//! Render live notification copy into the Windows hero image. The OS title and body
//! remain present for accessibility and Notification Center search.

use fontdue::{
    layout::{CoordinateSystem, Layout, LayoutSettings, TextStyle},
    Font, FontSettings,
};
use image::{
    codecs::png::{CompressionType, FilterType, PngEncoder},
    imageops, ImageEncoder, ImageFormat, Rgba, RgbaImage,
};
use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    hash::{Hash, Hasher},
    sync::{Arc, Mutex, OnceLock},
};

const WIDTH: u32 = 1024;
const HEIGHT: u32 = 512;
const TEXT_X: f32 = 78.0;
const TEXT_WIDTH: f32 = 900.0;
const BODY_TEXT_WIDTH: f32 = 820.0;
const TITLE_SIZE: f32 = 49.0;
const BODY_SIZE: f32 = 29.0;

fn bytes_key(bytes: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

fn resized_artwork(artwork: &[u8]) -> Result<RgbaImage, String> {
    static CACHE: OnceLock<Mutex<HashMap<u64, RgbaImage>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = bytes_key(artwork);
    if let Some(cached) = cache.lock().map_err(|error| error.to_string())?.get(&key) {
        return Ok(cached.clone());
    }
    let base = image::load_from_memory_with_format(artwork, ImageFormat::Png)
        .map_err(|error| error.to_string())?
        .to_rgba8();
    let resized = imageops::resize(&base, WIDTH, HEIGHT, imageops::FilterType::Triangle);
    cache
        .lock()
        .map_err(|error| error.to_string())?
        .insert(key, resized.clone());
    Ok(resized)
}

fn loaded_font(bytes: &[u8]) -> Result<Arc<Font>, String> {
    static CACHE: OnceLock<Mutex<HashMap<u64, Arc<Font>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = bytes_key(bytes);
    if let Some(cached) = cache.lock().map_err(|error| error.to_string())?.get(&key) {
        return Ok(Arc::clone(cached));
    }
    let font = Arc::new(
        Font::from_bytes(bytes, FontSettings::default()).map_err(|error| error.to_string())?,
    );
    cache
        .lock()
        .map_err(|error| error.to_string())?
        .insert(key, Arc::clone(&font));
    Ok(font)
}

fn clean_copy(value: &str, max_chars: usize) -> String {
    let bounded = value
        .chars()
        .take(max_chars * 4)
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let collapsed = bounded.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut characters = collapsed.chars();
    let mut clipped = characters.by_ref().take(max_chars).collect::<String>();
    if characters.next().is_some() {
        clipped.pop();
        clipped.push('…');
    }
    clipped
}

fn text_width(value: &str, font: &Font, size: f32) -> f32 {
    value
        .chars()
        .map(|character| font.metrics(character, size).advance_width)
        .sum()
}

fn fit_line(value: &str, font: &Font, size: f32, max_width: f32) -> String {
    if text_width(value, font, size) <= max_width {
        return value.to_owned();
    }
    let mut line = String::new();
    let mut width = 0.0;
    let ellipsis_width = text_width("…", font, size);
    for character in value.chars() {
        let advance = font.metrics(character, size).advance_width;
        if width + advance + ellipsis_width > max_width {
            break;
        }
        line.push(character);
        width += advance;
    }
    format!("{}…", line.trim_end())
}

fn body_lines(value: &str, font: &Font) -> Vec<String> {
    let mut lines = Vec::with_capacity(2);
    let mut current = String::new();
    let mut clipped = false;
    for word in value.split_whitespace() {
        let candidate = if current.is_empty() {
            word.to_owned()
        } else {
            format!("{current} {word}")
        };
        if text_width(&candidate, font, BODY_SIZE) <= BODY_TEXT_WIDTH {
            current = candidate;
        } else if lines.is_empty() && !current.is_empty() {
            lines.push(current);
            current = word.to_owned();
        } else if current.is_empty() {
            current = fit_line(word, font, BODY_SIZE, BODY_TEXT_WIDTH);
            clipped = true;
            break;
        } else {
            clipped = true;
            break;
        }
    }
    if !current.is_empty() {
        let with_end = if clipped {
            format!("{current}…")
        } else {
            current
        };
        lines.push(fit_line(&with_end, font, BODY_SIZE, BODY_TEXT_WIDTH));
    }
    lines.truncate(2);
    lines
}

fn blend(pixel: &mut Rgba<u8>, color: [u8; 3], coverage: u8) {
    let coverage = u16::from(coverage);
    for (channel, source) in color.into_iter().enumerate() {
        pixel[channel] = ((u16::from(source) * coverage
            + u16::from(pixel[channel]) * (255 - coverage))
            / 255) as u8;
    }
    pixel[3] = 255;
}

fn draw_text(image: &mut RgbaImage, font: &Font, text: &str, size: f32, y: f32, color: [u8; 3]) {
    if text.is_empty() {
        return;
    }
    let mut layout = Layout::new(CoordinateSystem::PositiveYDown);
    layout.reset(&LayoutSettings {
        x: TEXT_X,
        y,
        ..LayoutSettings::default()
    });
    layout.append(&[font], &TextStyle::new(text, size, 0));
    for glyph in layout.glyphs() {
        let (metrics, bitmap) = font.rasterize_config(glyph.key);
        let x = glyph.x.round() as i32;
        let y = glyph.y.round() as i32;
        for row in 0..metrics.height {
            for column in 0..metrics.width {
                let px = x + column as i32;
                let py = y + row as i32;
                if px >= 0 && py >= 0 && px < WIDTH as i32 && py < HEIGHT as i32 {
                    blend(
                        image.get_pixel_mut(px as u32, py as u32),
                        color,
                        bitmap[row * metrics.width + column],
                    );
                }
            }
        }
    }
}

pub(crate) fn render(
    artwork: &[u8],
    title: &str,
    body: &str,
    regular_font: &[u8],
    bold_font: &[u8],
) -> Result<Vec<u8>, String> {
    let mut image = resized_artwork(artwork)?;
    let regular = loaded_font(regular_font)?;
    let bold = loaded_font(bold_font)?;
    let title = clean_copy(title, 100);
    let body = clean_copy(body, 240);

    // The art stays visible above this quiet, warm text panel.
    for y in 306..HEIGHT {
        for x in 0..WIDTH {
            blend(image.get_pixel_mut(x, y), [248, 239, 226], 226);
        }
    }
    for y in 334..476 {
        for x in 48..54 {
            blend(image.get_pixel_mut(x, y), [180, 91, 48], 255);
        }
    }
    let title = fit_line(&title, &bold, TITLE_SIZE, TEXT_WIDTH);
    draw_text(&mut image, &bold, &title, TITLE_SIZE, 327.0, [56, 38, 28]);
    for (index, line) in body_lines(&body, &regular).iter().enumerate() {
        draw_text(
            &mut image,
            &regular,
            line,
            BODY_SIZE,
            398.0 + index as f32 * 39.0,
            [96, 70, 52],
        );
    }

    let mut output = Vec::new();
    PngEncoder::new_with_quality(&mut output, CompressionType::Fast, FilterType::Sub)
        .write_image(
            image.as_raw(),
            WIDTH,
            HEIGHT,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|error| error.to_string())?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_live_copy_and_renders_a_png() {
        let fonts = std::path::PathBuf::from(std::env::var("WINDIR").unwrap()).join("Fonts");
        let regular = std::fs::read(fonts.join("segoeui.ttf")).unwrap();
        let bold_font_bytes = std::fs::read(fonts.join("segoeuib.ttf")).unwrap();
        let artwork = include_bytes!("../icons/notification-credential-expired.png");
        let rendered = render(
            artwork,
            &format!("Deepgram API key expired {}", "long ".repeat(80)),
            &format!(
                "Detected 2:35 PM. Open Settings to replace the key. {}",
                "detail ".repeat(80)
            ),
            &regular,
            &bold_font_bytes,
        )
        .unwrap();
        let image = image::load_from_memory(&rendered).unwrap().to_rgba8();
        assert_eq!(image.dimensions(), (WIDTH, HEIGHT));
        assert!(rendered.len() < 2_000_000);
        let dark_title_pixels = (327..390)
            .flat_map(|y| (78..980).map(move |x| (x, y)))
            .filter(|&(x, y)| image.get_pixel(x, y)[0] < 130)
            .count();
        let dark_body_pixels = (398..485)
            .flat_map(|y| (78..980).map(move |x| (x, y)))
            .filter(|&(x, y)| image.get_pixel(x, y)[0] < 150)
            .count();
        assert!(dark_title_pixels > 100);
        assert!(dark_body_pixels > 100);
        let bold = Font::from_bytes(&bold_font_bytes[..], FontSettings::default()).unwrap();
        assert!(clean_copy(&"a".repeat(250), 100).ends_with('…'));
        assert!(fit_line(&"wide ".repeat(80), &bold, TITLE_SIZE, TEXT_WIDTH).ends_with('…'));
        let title = fit_line(
            "Finished mapping every workspace document and synchronizing the project",
            &bold,
            TITLE_SIZE,
            TEXT_WIDTH,
        );
        let title_only = render(artwork, &title, "", &regular, &bold_font_bytes).unwrap();
        let title_only_image = image::load_from_memory(&title_only).unwrap().to_rgba8();
        let dark_pixels_below_title = (395..480)
            .flat_map(|y| (78..980).map(move |x| (x, y)))
            .filter(|&(x, y)| title_only_image.get_pixel(x, y)[0] < 80)
            .count();
        assert_eq!(dark_pixels_below_title, 0, "title must stay on one line");
    }
}
