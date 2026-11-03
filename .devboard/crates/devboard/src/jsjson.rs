//! JSON text compatible with JavaScript's `JSON.stringify`.
//!
//! The contract corpus compares frames byte for byte, so the server must emit
//! the same text a JavaScript runtime would: object keys in insertion order,
//! the ECMAScript number form, and the same escapes. `serde_json` alone is
//! close but formats integral floats as `1.0` and large or small numbers in
//! its own exponent form, so numbers go through [`number`].

use serde_json::Value;

/// Serializes one value exactly as `JSON.stringify(value)` would.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_value(value, &mut out);
    out
}

/// Appends one value's JSON text to `out`.
pub fn write_value(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => out.push_str(&number_text(number)),
        Value::String(text) => write_string(text, out),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(item, out);
            }
            out.push(']');
        }
        Value::Object(object) => {
            out.push('{');
            for (index, (key, item)) in object.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_string(key, out);
                out.push(':');
                write_value(item, out);
            }
            out.push('}');
        }
    }
}

/// The ECMAScript text of one JSON number.
fn number_text(number: &serde_json::Number) -> String {
    if let Some(integer) = number.as_i64() {
        return integer.to_string();
    }
    if let Some(integer) = number.as_u64() {
        return integer.to_string();
    }
    match number.as_f64() {
        Some(value) => number_f64(value),
        None => number.to_string(),
    }
}

/// The ECMAScript `Number::toString` form of a finite double.
///
/// The shortest round-trip digits come from Rust's exponential formatting;
/// the digits and the decimal exponent are then laid out by the rules in
/// ECMA-262 7.1.12.1, which is what `JSON.stringify` applies.
pub fn number_f64(value: f64) -> String {
    if !value.is_finite() {
        // JavaScript turns a non-finite number into null; no finite JSON
        // number exists for it.
        return "null".to_string();
    }
    if value == 0.0 {
        return "0".to_string();
    }
    let negative = value < 0.0;
    let magnitude = value.abs();
    let scientific = format!("{magnitude:e}");
    let (mantissa, exponent) = scientific
        .split_once('e')
        .expect("exponential formatting carries an exponent");
    let exponent: i32 = exponent
        .parse()
        .expect("exponential exponent is an integer");
    let digits: String = mantissa
        .chars()
        .filter(|character| *character != '.')
        .collect();
    let digits = digits.trim_end_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    let count = digits.len() as i32;
    // The decimal point sits after `point` digits.
    let point = exponent + 1;
    let mut text = String::new();
    if count <= point && point <= 21 {
        text.push_str(digits);
        for _ in 0..(point - count) {
            text.push('0');
        }
    } else if 0 < point && point <= 21 {
        text.push_str(&digits[..point as usize]);
        text.push('.');
        text.push_str(&digits[point as usize..]);
    } else if -6 < point && point <= 0 {
        text.push_str("0.");
        for _ in 0..(-point) {
            text.push('0');
        }
        text.push_str(digits);
    } else {
        text.push(digits.as_bytes()[0] as char);
        if count > 1 {
            text.push('.');
            text.push_str(&digits[1..]);
        }
        text.push('e');
        let power = point - 1;
        if power >= 0 {
            text.push('+');
        }
        text.push_str(&power.to_string());
    }
    if negative {
        format!("-{text}")
    } else {
        text
    }
}

/// Appends one JSON string literal, escaped as `JSON.stringify` escapes it.
pub fn write_string(value: &str, out: &mut String) {
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            character if (character as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", character as u32));
            }
            character => out.push(character),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_follow_ecmascript() {
        for (value, text) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.5, "-1.5"),
            (100000000000000000000.0, "100000000000000000000"),
            (1e21, "1e+21"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (1234.5, "1234.5"),
            (0.1, "0.1"),
        ] {
            assert_eq!(number_f64(value), text, "value {value}");
        }
    }

    #[test]
    fn objects_keep_insertion_order() {
        let value = json!({"b": 1, "a": [true, null, "x\n"]});
        assert_eq!(stringify(&value), "{\"b\":1,\"a\":[true,null,\"x\\n\"]}");
    }

    #[test]
    fn integral_float_values_print_as_integers() {
        let value = json!({"n": 2.0});
        assert_eq!(stringify(&value), "{\"n\":2}");
    }
}
