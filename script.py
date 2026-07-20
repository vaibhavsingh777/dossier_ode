import pdfplumber
import pandas as pd
import re

def convert_pdf_to_csv(pdf_path, output_csv_path):
    all_rows = []
    current_chapter = "Unknown"  # Tracks the current chapter section
    
    # Define the final CSV clean headers
    headers = [
        "Corresponding HSN Code", 
        "GST Code", 
        "Item Description", 
        "GST Rate", 
        "Flag (Specific Rate etc.)", 
        "Amount", 
        "UQC", 
        "Conditions",
        "Chapter"  # Added column to neatly organize by Chapter sections
    ]

    print("Opening PDF and extracting table data...")
    with pdfplumber.open(pdf_path) as pdf:
        for page_num, page in enumerate(pdf.pages, start=1):
            # Extract structured tables based on visual grid lines
            tables = page.extract_tables()
            
            for table in tables:
                for row in table:
                    # Skip completely empty rows
                    if not any(row):
                        continue
                    
                    # Convert elements to string and strip trailing whitespaces
                    cleaned_row = [str(cell).strip() if cell is not None else "" for cell in row]
                    row_text_combined = " ".join(cleaned_row)
                    
                    # 1. Detect and capture Chapter header rows (e.g., "CHAPTER-1")
                    chapter_match = re.search(r'(CHAPTER\s*-\s*\d+)', row_text_combined, re.IGNORECASE)
                    if chapter_match:
                        current_chapter = chapter_match.group(1).upper()
                        continue  # Skip adding this structural row as a data row
                    
                    # 2. Skip table header repetitions if the PDF spans multiple pages
                    if "GST Code" in cleaned_row or "Item Description" in cleaned_row:
                        continue
                    
                    # 3. Process regular data rows (expecting 8 columns based on the format)
                    if len(cleaned_row) >= 8:
                        # Process stacked HSN codes (split by newline, join with commas)
                        hsn_codes = ", ".join([line.strip() for line in cleaned_row[0].split('\n') if line.strip()])
                        
                        gst_code = cleaned_row[1].replace('\n', ' ')
                        
                        # Process multi-line item descriptions into a single clean sentence
                        description = " ".join([line.strip() for line in cleaned_row[2].split('\n') if line.strip()])
                        
                        gst_rate = cleaned_row[3].replace('\n', ' ')
                        flag = cleaned_row[4].replace('\n', ' ')
                        amount = cleaned_row[5].replace('\n', ' ')
                        uqc = cleaned_row[6].replace('\n', ' ')
                        conditions = cleaned_row[7].replace('\n', ' ')
                        
                        # Append the structured record
                        all_rows.append([
                            hsn_codes, gst_code, description, gst_rate, 
                            flag, amount, uqc, conditions, current_chapter
                        ])

    # Convert to DataFrame and save
    if all_rows:
        df = pd.DataFrame(all_rows, columns=headers)
        df.to_csv(output_csv_path, index=False, encoding='utf-8')
        print(f"Success! Saved {len(df)} rows to: {output_csv_path}")
    else:
        print("No matching data rows found. Please check if the PDF layout matches.")

# --- Execution ---
# Replace these filenames with your actual file paths
pdf_filename = "IGST.pdf"
csv_filename = "neat_output_results.csv"

convert_pdf_to_csv(pdf_filename, csv_filename)