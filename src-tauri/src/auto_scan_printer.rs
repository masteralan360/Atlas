use serde::Serialize;
#[cfg(target_os = "windows")]
use base64::Engine;
#[cfg(target_os = "windows")]
use std::io::Cursor;

#[derive(Debug, Serialize)]
pub struct AutoScanPrinterInfo {
    name: String,
    identifier: String,
    interface_type: String,
}

#[tauri::command]
pub async fn list_auto_scan_printers() -> Result<Vec<AutoScanPrinterInfo>, String> {
    #[cfg(target_os = "windows")]
    {
        return tauri::async_runtime::spawn_blocking(windows::list_printers)
            .await
            .map_err(|error| format!("auto_scan_native_error:{error}"))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("auto_scan_native_printing_unavailable".into())
    }
}

#[tauri::command]
pub async fn is_auto_scan_printer_available(printer_name: String) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        return tauri::async_runtime::spawn_blocking(move || {
            windows::is_printer_available(&printer_name)
        })
        .await
        .map_err(|error| format!("auto_scan_native_error:{error}"))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = printer_name;
        Err("auto_scan_native_printing_unavailable".into())
    }
}

#[tauri::command]
pub async fn print_auto_scan_label(
    printer_name: String,
    png_base64: String,
    page_width_mm: f64,
    page_height_mm: f64,
    title: String,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        return tauri::async_runtime::spawn_blocking(move || {
            let image = decode_png(&png_base64)?;
            windows::print_png(&printer_name, &title, page_width_mm, page_height_mm, &image)
        })
        .await
        .map_err(|error| format!("auto_scan_native_error:{error}"))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (
            printer_name,
            png_base64,
            page_width_mm,
            page_height_mm,
            title,
        );
        Err("auto_scan_native_printing_unavailable".into())
    }
}

#[cfg(target_os = "windows")]
struct DecodedPng {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

#[cfg(target_os = "windows")]
fn decode_png(encoded: &str) -> Result<DecodedPng, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "auto_scan_invalid_label_image".to_string())?;
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder
        .read_info()
        .map_err(|_| "auto_scan_invalid_label_image".to_string())?;
    let output_size = reader.output_buffer_size();
    let mut buffer = vec![0; output_size];
    let info = reader
        .next_frame(&mut buffer)
        .map_err(|_| "auto_scan_invalid_label_image".to_string())?;
    let frame = &buffer[..info.buffer_size()];
    let pixel_count = (info.width as usize)
        .checked_mul(info.height as usize)
        .filter(|count| *count > 0 && *count <= 25_000_000)
        .ok_or_else(|| "auto_scan_invalid_label_image".to_string())?;
    let mut rgba = Vec::with_capacity(pixel_count * 4);

    match info.color_type {
        png::ColorType::Rgba => rgba.extend_from_slice(frame),
        png::ColorType::Rgb => {
            for pixel in frame.chunks_exact(3) {
                rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
            }
        }
        png::ColorType::GrayscaleAlpha => {
            for pixel in frame.chunks_exact(2) {
                rgba.extend_from_slice(&[pixel[0], pixel[0], pixel[0], pixel[1]]);
            }
        }
        png::ColorType::Grayscale => {
            for value in frame {
                rgba.extend_from_slice(&[*value, *value, *value, 255]);
            }
        }
        png::ColorType::Indexed => {
            return Err("auto_scan_invalid_label_image".into());
        }
    }

    if rgba.len() != pixel_count * 4 {
        return Err("auto_scan_invalid_label_image".into());
    }

    Ok(DecodedPng {
        width: info.width,
        height: info.height,
        rgba,
    })
}

#[cfg(target_os = "windows")]
mod windows {
    use super::{AutoScanPrinterInfo, DecodedPng};
    use std::ffi::OsStr;
    use std::iter::once;
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Graphics::Gdi::{
        CreateDCW, DeleteDC, GetDeviceCaps, StretchDIBits, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DEVMODEW, DIB_RGB_COLORS, DMPAPER_USER, DM_IN_BUFFER, DM_OUT_BUFFER, DM_PAPERLENGTH,
        DM_PAPERSIZE, DM_PAPERWIDTH, HORZRES, LOGPIXELSX, LOGPIXELSY, PHYSICALHEIGHT,
        PHYSICALOFFSETX, PHYSICALOFFSETY, PHYSICALWIDTH, SRCCOPY, VERTRES,
    };
    use windows_sys::Win32::Graphics::Printing::{
        ClosePrinter, DocumentPropertiesW, EnumPrintersW, GetPrinterW, OpenPrinterW,
        PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_HANDLE, PRINTER_INFO_4W,
        PRINTER_INFO_6,
    };
    use windows_sys::Win32::Storage::Xps::{
        AbortDoc, EndDoc, EndPage, StartDocW, StartPage, DOCINFOW,
    };

    const PRINTER_UNAVAILABLE_MASK: u32 = 0x0000_0001
        | 0x0000_0002
        | 0x0000_0004
        | 0x0000_0008
        | 0x0000_0010
        | 0x0000_0040
        | 0x0000_0080
        | 0x0000_0800
        | 0x0000_1000
        | 0x0004_0000
        | 0x0008_0000
        | 0x0010_0000
        | 0x0020_0000
        | 0x0040_0000
        | 0x0080_0000;
    const MAX_CUSTOM_PAPER_TENTHS_MM: f64 = i16::MAX as f64;

    pub fn list_printers() -> Result<Vec<AutoScanPrinterInfo>, String> {
        let mut bytes_needed = 0u32;
        let mut returned = 0u32;
        unsafe {
            EnumPrintersW(
                PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS,
                null(),
                4,
                null_mut(),
                0,
                &mut bytes_needed,
                &mut returned,
            );
        }
        if bytes_needed == 0 {
            return Ok(Vec::new());
        }

        let mut buffer = aligned_buffer(bytes_needed as usize);
        let listed = unsafe {
            EnumPrintersW(
                PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS,
                null(),
                4,
                buffer.as_mut_ptr().cast(),
                bytes_needed,
                &mut bytes_needed,
                &mut returned,
            )
        };
        if listed == 0 {
            return Err(last_error("auto_scan_printer_list_failed"));
        }

        let entries = unsafe {
            std::slice::from_raw_parts(buffer.as_ptr().cast::<PRINTER_INFO_4W>(), returned as usize)
        };
        let mut printers = entries
            .iter()
            .filter_map(|entry| {
                let name = wide_string(entry.pPrinterName);
                (!name.is_empty()).then_some(name)
            })
            .map(|name| AutoScanPrinterInfo {
                identifier: name.clone(),
                name,
                interface_type: "Windows printer".into(),
            })
            .collect::<Vec<_>>();
        printers.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
        printers.dedup_by(|left, right| left.name.eq_ignore_ascii_case(&right.name));
        Ok(printers)
    }

    pub fn is_printer_available(printer_name: &str) -> Result<bool, String> {
        let name = wide(printer_name);
        let handle = open_printer(&name)?;
        let mut bytes_needed = 0u32;
        unsafe {
            GetPrinterW(handle, 6, null_mut(), 0, &mut bytes_needed);
        }
        if bytes_needed < size_of::<PRINTER_INFO_6>() as u32 {
            unsafe { ClosePrinter(handle) };
            return Err(last_error("auto_scan_printer_status_failed"));
        }

        let mut buffer = aligned_buffer(bytes_needed as usize);
        let read_status = unsafe {
            GetPrinterW(
                handle,
                6,
                buffer.as_mut_ptr().cast(),
                bytes_needed,
                &mut bytes_needed,
            )
        };
        unsafe { ClosePrinter(handle) };
        if read_status == 0 {
            return Err(last_error("auto_scan_printer_status_failed"));
        }

        let status = unsafe { (*(buffer.as_ptr().cast::<PRINTER_INFO_6>())).dwStatus };
        Ok(status & PRINTER_UNAVAILABLE_MASK == 0)
    }

    pub fn print_png(
        printer_name: &str,
        title: &str,
        page_width_mm: f64,
        page_height_mm: f64,
        image: &DecodedPng,
    ) -> Result<(), String> {
        if !page_width_mm.is_finite()
            || !page_height_mm.is_finite()
            || page_width_mm <= 0.0
            || page_height_mm <= 0.0
            || page_width_mm * 10.0 > MAX_CUSTOM_PAPER_TENTHS_MM
            || page_height_mm * 10.0 > MAX_CUSTOM_PAPER_TENTHS_MM
        {
            return Err("auto_scan_invalid_label_size".into());
        }
        if !is_printer_available(printer_name)? {
            return Err("auto_scan_printer_unavailable".into());
        }

        let name = wide(printer_name);
        let handle = open_printer(&name)?;
        let mode = match custom_devmode(handle, &name, page_width_mm, page_height_mm) {
            Ok(mode) => mode,
            Err(error) => {
                unsafe { ClosePrinter(handle) };
                return Err(error);
            }
        };
        let driver = wide("WINSPOOL");
        let hdc =
            unsafe { CreateDCW(driver.as_ptr(), name.as_ptr(), null(), mode.as_ptr().cast()) };
        unsafe { ClosePrinter(handle) };
        if hdc.is_null() {
            return Err(last_error("auto_scan_printer_open_failed"));
        }

        let result = print_bitmap(hdc, title, page_width_mm, page_height_mm, image);
        unsafe { DeleteDC(hdc) };
        result
    }

    fn print_bitmap(
        hdc: windows_sys::Win32::Graphics::Gdi::HDC,
        title: &str,
        page_width_mm: f64,
        page_height_mm: f64,
        image: &DecodedPng,
    ) -> Result<(), String> {
        let x_dpi = unsafe { GetDeviceCaps(hdc, LOGPIXELSX as i32) };
        let y_dpi = unsafe { GetDeviceCaps(hdc, LOGPIXELSY as i32) };
        let physical_width = unsafe { GetDeviceCaps(hdc, PHYSICALWIDTH as i32) };
        let physical_height = unsafe { GetDeviceCaps(hdc, PHYSICALHEIGHT as i32) };
        let offset_x = unsafe { GetDeviceCaps(hdc, PHYSICALOFFSETX as i32) };
        let offset_y = unsafe { GetDeviceCaps(hdc, PHYSICALOFFSETY as i32) };
        let printable_width = unsafe { GetDeviceCaps(hdc, HORZRES as i32) };
        let printable_height = unsafe { GetDeviceCaps(hdc, VERTRES as i32) };
        if x_dpi <= 0 || y_dpi <= 0 || physical_width <= 0 || physical_height <= 0 {
            return Err("auto_scan_printer_setup_failed".into());
        }

        let page_width_px = (page_width_mm * x_dpi as f64 / 25.4).round() as i32;
        let page_height_px = (page_height_mm * y_dpi as f64 / 25.4).round() as i32;
        if page_width_px > physical_width || page_height_px > physical_height {
            return Err("auto_scan_printer_paper_size_unsupported".into());
        }

        let mut pixels = Vec::with_capacity(image.rgba.len());
        for pixel in image.rgba.chunks_exact(4) {
            pixels.extend_from_slice(&[pixel[2], pixel[1], pixel[0], 255]);
        }
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: image.width as i32,
                biHeight: -(image.height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                biSizeImage: pixels.len().min(u32::MAX as usize) as u32,
                ..Default::default()
            },
            ..Default::default()
        };

        let title_wide = wide(title);
        let mut document = DOCINFOW {
            cbSize: size_of::<DOCINFOW>() as i32,
            lpszDocName: title_wide.as_ptr(),
            ..Default::default()
        };
        let started = unsafe { StartDocW(hdc, &mut document) };
        if started <= 0 {
            return Err(last_error("auto_scan_print_job_failed"));
        }
        if unsafe { StartPage(hdc) } <= 0 {
            unsafe { AbortDoc(hdc) };
            return Err(last_error("auto_scan_print_job_failed"));
        }

        let left = if printable_width > 0 { -offset_x } else { 0 };
        let top = if printable_height > 0 { -offset_y } else { 0 };
        let dib_result = unsafe {
            StretchDIBits(
                hdc,
                left,
                top,
                page_width_px,
                page_height_px,
                0,
                0,
                image.width as i32,
                image.height as i32,
                pixels.as_ptr().cast(),
                &mut info,
                DIB_RGB_COLORS,
                SRCCOPY,
            )
        };
        if dib_result == 0 || dib_result == -1 {
            unsafe { AbortDoc(hdc) };
            return Err(last_error("auto_scan_print_job_failed"));
        }
        if unsafe { EndPage(hdc) } <= 0 {
            unsafe { AbortDoc(hdc) };
            return Err(last_error("auto_scan_print_job_failed"));
        }
        if unsafe { EndDoc(hdc) } <= 0 {
            return Err(last_error("auto_scan_print_job_failed"));
        }
        Ok(())
    }

    fn custom_devmode(
        handle: PRINTER_HANDLE,
        device_name: &[u16],
        width_mm: f64,
        height_mm: f64,
    ) -> Result<Vec<u64>, String> {
        let required = unsafe {
            DocumentPropertiesW(
                null_mut(),
                handle,
                device_name.as_ptr(),
                null_mut(),
                null(),
                0,
            )
        };
        if required < size_of::<DEVMODEW>() as i32 {
            return Err(last_error("auto_scan_printer_setup_failed"));
        }
        let mut input = aligned_buffer(required as usize);
        let populated = unsafe {
            DocumentPropertiesW(
                null_mut(),
                handle,
                device_name.as_ptr(),
                input.as_mut_ptr().cast(),
                null(),
                DM_OUT_BUFFER,
            )
        };
        if populated != 1 {
            return Err("auto_scan_printer_setup_failed".into());
        }

        let devmode = unsafe { &mut *input.as_mut_ptr().cast::<DEVMODEW>() };
        devmode.dmFields |= DM_PAPERSIZE | DM_PAPERWIDTH | DM_PAPERLENGTH;
        unsafe {
            let mut paper = devmode.Anonymous1.Anonymous1;
            paper.dmPaperSize = DMPAPER_USER as i16;
            paper.dmPaperWidth = (width_mm * 10.0).round() as i16;
            paper.dmPaperLength = (height_mm * 10.0).round() as i16;
            devmode.Anonymous1.Anonymous1 = paper;
        }

        let mut output = aligned_buffer(required as usize);
        let accepted = unsafe {
            DocumentPropertiesW(
                null_mut(),
                handle,
                device_name.as_ptr(),
                output.as_mut_ptr().cast(),
                input.as_ptr().cast(),
                DM_IN_BUFFER | DM_OUT_BUFFER,
            )
        };
        if accepted != 1 {
            return Err("auto_scan_printer_paper_size_unsupported".into());
        }
        let applied = unsafe { &*output.as_ptr().cast::<DEVMODEW>() };
        let applied_paper = unsafe { applied.Anonymous1.Anonymous1 };
        let requested_width = (width_mm * 10.0).round() as i16;
        let requested_length = (height_mm * 10.0).round() as i16;
        if applied_paper.dmPaperWidth != requested_width
            || applied_paper.dmPaperLength != requested_length
        {
            return Err("auto_scan_printer_paper_size_unsupported".into());
        }
        Ok(output)
    }

    fn open_printer(name: &[u16]) -> Result<PRINTER_HANDLE, String> {
        let mut handle = PRINTER_HANDLE { Value: null_mut() };
        let opened = unsafe { OpenPrinterW(name.as_ptr(), &mut handle, null()) };
        if opened == 0 {
            Err("auto_scan_printer_unavailable".into())
        } else {
            Ok(handle)
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain(once(0)).collect()
    }

    fn wide_string(value: windows_sys::core::PWSTR) -> String {
        if value.is_null() {
            return String::new();
        }
        let mut length = 0usize;
        unsafe {
            while *value.add(length) != 0 {
                length += 1;
            }
            String::from_utf16_lossy(std::slice::from_raw_parts(value, length))
        }
    }

    fn aligned_buffer(bytes: usize) -> Vec<u64> {
        vec![0; bytes.div_ceil(size_of::<u64>())]
    }

    fn last_error(prefix: &str) -> String {
        let code = unsafe { GetLastError() };
        format!("{prefix}:{code}")
    }
}
