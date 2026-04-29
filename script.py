import time
import pyautogui

def process_barcode(data):
    # Modify this if you want transformation logic
    # Example: strip spaces or add prefix
    return data.strip()

def send_barcode(data, delay=0.02):
    for char in data:
        pyautogui.write(char)
        time.sleep(delay)  # mimic real scanner speed
    pyautogui.press("enter")

if __name__ == "__main__":
    barcode = input("Scan/Enter barcode: ")

    processed = process_barcode(barcode)

    print("Focus your target input field NOW...")
    time.sleep(3)  # gives you time to click into a field

    send_barcode(processed)