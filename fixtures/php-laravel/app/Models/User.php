<?php
namespace App\Models;

/** A person. */
class User extends Model implements Keyed
{
    use HasAudit;
    public function __construct(private string $id) {}
    public function save(): void { $this->validate(); $this->audit(); }
    public function key(): string { return $this->id; }
    public static function query(): self { return new static('x'); }
}
